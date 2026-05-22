import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/index';
import {
  docusealConfig,
  docusealTemplates,
  docusealSubmissions,
  docusealSubmitters,
  docusealAudit,
} from '../../db/schema/docuseal';
import type { DocusealSubmissionMetadata } from '../../db/schema/docuseal';
import { requireAdmin } from '../../middleware/auth';
import { createDocusealClient } from '../../services/docuseal/client';
import { resolveMergeFields } from '../../services/docuseal/mergeFields';
import { docusealSubmissionsCreatedTotal } from '../../services/docuseal/metrics';
import pino from 'pino';

const logger = pino({ name: 'docuseal-bulk-send' });

// Rate limit: max submissions per minute (respects DocuSeal API limits)
const RATE_LIMIT_PER_MINUTE = 10;
const RATE_LIMIT_DELAY_MS = Math.ceil(60_000 / RATE_LIMIT_PER_MINUTE);

const recipientSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  merge_overrides: z.record(z.string(), z.string()).optional(),
});

const bulkSendSchema = z.object({
  template_id: z.string().uuid(),
  recipients: z.array(recipientSchema).min(1).max(500),
  delivery_channel: z.enum(['email', 'sms', 'both']).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
  custom_message: z.string().max(1000).optional(),
});

export function createDocusealBulkSendRouter(db: Db): Router {
  const router = Router();

  router.use(requireAdmin);

  // ── POST /api/v1/docuseal/bulk-send ───────────────────────────────────────
  // Sends the same template to many recipients, rate-limited to respect DocuSeal API limits.
  // Returns per-row results synchronously (suitable for up to ~100 rows; larger batches
  // should be queued — noted as a TODO for when we add a job queue).

  router.post('/', async (req, res): Promise<void> => {
    const parsed = bulkSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const { template_id, recipients, delivery_channel, expires_in_days, custom_message } = parsed.data;

    const [config] = await db
      .select()
      .from(docusealConfig)
      .where(and(eq(docusealConfig.orgId, req.auth.org_id), eq(docusealConfig.isActive, true)))
      .limit(1);

    if (!config) {
      res.status(422).json({ error: 'docuseal_not_configured' });
      return;
    }

    const [template] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, template_id), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!template || template.isArchived) {
      res.status(404).json({ error: 'template_not_found' });
      return;
    }

    const client = createDocusealClient({
      apiToken: config.apiToken,
      orgId: req.auth.org_id,
      mode: config.mode as 'saas' | 'self_hosted',
      endpointUrl: config.endpointUrl,
    });

    const channel = delivery_channel ?? config.defaults?.deliveryChannel ?? 'email';
    const sendEmail = channel === 'email' || channel === 'both';
    const sendSms = channel === 'sms' || channel === 'both';
    const expiresInDays = expires_in_days ?? config.defaults?.expirationDays ?? 30;
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);

    const results: Array<{
      index: number;
      email: string;
      success: boolean;
      submission_id?: string;
      error?: string;
    }> = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i]!;

      // Rate-limit gap between requests
      if (i > 0) await sleep(RATE_LIMIT_DELAY_MS);

      try {
        const { values: mergeValues } = await resolveMergeFields({
          db,
          orgId: req.auth.org_id,
          projectId: null,
          requestedFields: template.mergeFields as string[],
          overrides: recipient.merge_overrides,
        });

        const remoteSubmission = await client.createSubmission({
          template_id: template.docusealId,
          submitters: [
            {
              role: recipient.role,
              name: recipient.name,
              email: recipient.email,
              ...(recipient.phone !== undefined ? { phone: recipient.phone } : {}),
              send_email: sendEmail,
              send_sms: sendSms,
              values: mergeValues,
            },
          ],
          ...(custom_message !== undefined ? { message: { body: custom_message } } : {}),
          expire_at: expiresAt.toISOString(),
        });

        const metadata: DocusealSubmissionMetadata = {
          mergeValues,
          deliveryChannel: channel,
          ...(custom_message !== undefined ? { customMessage: custom_message } : {}),
        };

        const subRows = await db
          .insert(docusealSubmissions)
          .values({
            orgId: req.auth.org_id,
            projectId: null,
            templateId: template.id,
            docusealId: String(remoteSubmission.id),
            status: 'sent',
            sentAt: new Date(),
            expiresAt,
            metadata,
          })
          .returning({ id: docusealSubmissions.id });

        const submissionId = subRows[0]?.id;
        if (submissionId) {
          await db.insert(docusealSubmitters).values({
            submissionId,
            role: recipient.role,
            name: recipient.name,
            email: recipient.email,
            phone: recipient.phone ?? null,
            order: 1,
            status: 'pending' as const,
          });

          await db.insert(docusealAudit).values({
            submissionId,
            eventType: 'submission.sent',
            eventPayload: { docuseal_id: remoteSubmission.id, bulk: true, sent_by: req.auth.user_id },
          });

          docusealSubmissionsCreatedTotal.inc({ template_category: template.category });
        }

        results.push({
          index: i,
          email: recipient.email,
          success: true as const,
          ...(submissionId !== undefined ? { submission_id: submissionId } : {}),
        });
        logger.info({ orgId: req.auth.org_id, i, email: recipient.email.replace(/@.*/, '@***') }, 'Bulk row sent');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ orgId: req.auth.org_id, i, err }, 'Bulk row failed');
        results.push({ index: i, email: recipient.email, success: false as const, error: message });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    res.status(failed === recipients.length ? 502 : 200).json({
      total: recipients.length,
      succeeded,
      failed,
      results,
    });
  });

  return router;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
