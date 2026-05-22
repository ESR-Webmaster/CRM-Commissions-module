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
import { resolveMergeFields, MERGE_FIELD_REGISTRY } from '../../services/docuseal/mergeFields';
import { docusealSubmissionsCreatedTotal } from '../../services/docuseal/metrics';
import { desc } from 'drizzle-orm';
import pino from 'pino';

const logger = pino({ name: 'docuseal-submissions' });

const signerSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  order: z.number().int().min(1).optional(),
});

const createSubmissionSchema = z.object({
  template_id: z.string().uuid(),
  project_id: z.string().uuid().optional(),
  signers: z.array(signerSchema).min(1),
  merge_overrides: z.record(z.string(), z.string()).optional(),
  custom_message: z.string().max(1000).optional(),
  delivery_channel: z.enum(['email', 'sms', 'both']).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

async function getActiveConfig(db: Db, orgId: string) {
  const [config] = await db
    .select()
    .from(docusealConfig)
    .where(and(eq(docusealConfig.orgId, orgId), eq(docusealConfig.isActive, true)))
    .limit(1);
  return config ?? null;
}

export function createDocusealSubmissionsRouter(db: Db): Router {
  const router = Router();

  // ── POST /api/v1/docuseal/submissions ─────────────────────────────────────
  // 3-click send: resolve merge fields, create submission in DocuSeal, persist.

  router.post('/', async (req, res): Promise<void> => {
    const parsed = createSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const input = parsed.data;
    const config = await getActiveConfig(db, req.auth.org_id);
    if (!config) {
      res.status(422).json({ error: 'docuseal_not_configured' });
      return;
    }

    // Verify template belongs to this org
    const [template] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, input.template_id), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!template || template.isArchived) {
      res.status(404).json({ error: 'template_not_found' });
      return;
    }

    // Resolve merge fields
    const { values: mergeValues, warnings } = await resolveMergeFields({
      db,
      orgId: req.auth.org_id,
      projectId: input.project_id,
      requestedFields: template.mergeFields as string[],
      overrides: input.merge_overrides,
    });

    // Build delivery flags from channel selection
    const channel = input.delivery_channel ?? config.defaults?.deliveryChannel ?? 'email';
    const sendEmail = channel === 'email' || channel === 'both';
    const sendSms = channel === 'sms' || channel === 'both';

    // Build expiry
    const expiresInDays = input.expires_in_days ?? config.defaults?.expirationDays ?? 30;
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);

    // Create submission in DocuSeal
    const client = createDocusealClient({
      apiToken: config.apiToken,
      orgId: req.auth.org_id,
      mode: config.mode as 'saas' | 'self_hosted',
      endpointUrl: config.endpointUrl,
    });

    let remoteSubmission;
    try {
      remoteSubmission = await client.createSubmission({
        template_id: template.docusealId,
        submitters: input.signers.map((s) => ({
          role: s.role,
          name: s.name,
          email: s.email,
          ...(s.phone !== undefined ? { phone: s.phone } : {}),
          send_email: sendEmail,
          send_sms: sendSms,
          values: mergeValues,
        })),
        ...(input.custom_message !== undefined ? { message: { body: input.custom_message } } : {}),
        expire_at: expiresAt.toISOString(),
      });
    } catch (err) {
      logger.error({ orgId: req.auth.org_id, templateId: input.template_id, err }, 'DocuSeal createSubmission failed');
      res.status(502).json({ error: 'docuseal_api_error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Persist our submission record
    const metadata: DocusealSubmissionMetadata = {
      mergeValues,
      deliveryChannel: channel,
      ...(input.custom_message !== undefined ? { customMessage: input.custom_message } : {}),
    };

    const subRows = await db
      .insert(docusealSubmissions)
      .values({
        orgId: req.auth.org_id,
        projectId: input.project_id ?? null,
        templateId: template.id,
        docusealId: String(remoteSubmission.id),
        status: 'sent',
        sentAt: new Date(),
        expiresAt,
        metadata,
      })
      .returning();

    const submission = subRows[0];
    if (!submission) { res.status(500).json({ error: 'insert_failed' }); return; }

    // Persist submitter rows
    const submitterValues = input.signers.map((s, i) => ({
      submissionId: submission.id,
      role: s.role,
      name: s.name,
      email: s.email ?? null,
      phone: s.phone ?? null,
      order: s.order ?? i + 1,
      status: 'pending' as const,
    }));
    await db.insert(docusealSubmitters).values(submitterValues);

    // Write initial audit row
    await db.insert(docusealAudit).values({
      submissionId: submission.id,
      eventType: 'submission.sent',
      eventPayload: { docuseal_id: remoteSubmission.id, sent_by: req.auth.user_id },
    });

    docusealSubmissionsCreatedTotal.inc({ template_category: template.category });

    logger.info(
      { orgId: req.auth.org_id, submissionId: submission.id, docusealId: remoteSubmission.id },
      'Submission created'
    );

    res.status(201).json({
      submission,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  });

  // ── GET /api/v1/docuseal/submissions ──────────────────────────────────────

  router.get('/', async (req, res): Promise<void> => {
    const querySchema = z.object({
      project_id: z.string().uuid().optional(),
      status: z.enum(['draft','sent','viewed','partially_signed','signed','declined','voided','expired']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }

    const { project_id, status, limit, offset } = parsed.data;

    const rows = await db
      .select()
      .from(docusealSubmissions)
      .where(
        and(
          eq(docusealSubmissions.orgId, req.auth.org_id),
          project_id ? eq(docusealSubmissions.projectId, project_id) : undefined,
          status ? eq(docusealSubmissions.status, status) : undefined,
        )
      )
      .orderBy(desc(docusealSubmissions.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ submissions: rows, limit, offset, total: rows.length });
  });

  // ── GET /api/v1/docuseal/submissions/:id ──────────────────────────────────

  router.get('/:id', async (req, res): Promise<void> => {
    const [submission] = await db
      .select()
      .from(docusealSubmissions)
      .where(and(eq(docusealSubmissions.id, req.params['id']!), eq(docusealSubmissions.orgId, req.auth.org_id)))
      .limit(1);

    if (!submission) { res.status(404).json({ error: 'submission_not_found' }); return; }

    const [submitters, auditRows] = await Promise.all([
      db.select().from(docusealSubmitters).where(eq(docusealSubmitters.submissionId, submission.id)),
      db
        .select()
        .from(docusealAudit)
        .where(eq(docusealAudit.submissionId, submission.id))
        .orderBy(docusealAudit.receivedAt)
        .limit(50),
    ]);

    res.json({ submission, submitters, audit: auditRows });
  });

  // ── POST /api/v1/docuseal/submissions/:id/void ────────────────────────────

  router.post('/:id/void', async (req, res): Promise<void> => {
    const bodySchema = z.object({ reason: z.string().min(1).max(500) });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [submission] = await db
      .select()
      .from(docusealSubmissions)
      .where(and(eq(docusealSubmissions.id, req.params['id']!), eq(docusealSubmissions.orgId, req.auth.org_id)))
      .limit(1);

    if (!submission) { res.status(404).json({ error: 'submission_not_found' }); return; }
    if (['signed', 'declined', 'voided', 'expired'].includes(submission.status)) {
      res.status(422).json({ error: 'submission_already_terminal' });
      return;
    }

    const config = await getActiveConfig(db, req.auth.org_id);
    if (!config) { res.status(422).json({ error: 'docuseal_not_configured' }); return; }

    const client = createDocusealClient({
      apiToken: config.apiToken,
      orgId: req.auth.org_id,
      mode: config.mode as 'saas' | 'self_hosted',
      endpointUrl: config.endpointUrl,
    });

    try {
      await client.voidSubmission(submission.docusealId, parsed.data.reason);
    } catch (err) {
      logger.error({ submissionId: submission.id, err }, 'DocuSeal voidSubmission failed');
      res.status(502).json({ error: 'docuseal_api_error' });
      return;
    }

    await db
      .update(docusealSubmissions)
      .set({ status: 'voided', voidReason: parsed.data.reason, updatedAt: new Date() })
      .where(eq(docusealSubmissions.id, submission.id));

    await db.insert(docusealAudit).values({
      submissionId: submission.id,
      eventType: 'voided_by_user',
      eventPayload: { reason: parsed.data.reason, voided_by: req.auth.user_id },
    });

    res.json({ ok: true });
  });

  // ── POST /api/v1/docuseal/submissions/:id/refresh ─────────────────────────
  // Pulls current status from DocuSeal and corrects any drift.

  router.post('/:id/refresh', async (req, res): Promise<void> => {
    const [submission] = await db
      .select()
      .from(docusealSubmissions)
      .where(and(eq(docusealSubmissions.id, req.params['id']!), eq(docusealSubmissions.orgId, req.auth.org_id)))
      .limit(1);

    if (!submission) { res.status(404).json({ error: 'submission_not_found' }); return; }

    const config = await getActiveConfig(db, req.auth.org_id);
    if (!config) { res.status(422).json({ error: 'docuseal_not_configured' }); return; }

    const client = createDocusealClient({
      apiToken: config.apiToken,
      orgId: req.auth.org_id,
      mode: config.mode as 'saas' | 'self_hosted',
      endpointUrl: config.endpointUrl,
    });

    let remote;
    try {
      remote = await client.getSubmission(submission.docusealId);
    } catch (err) {
      res.status(502).json({ error: 'docuseal_api_error' });
      return;
    }

    const remoteStatus = mapRemoteStatus(remote.status) as typeof submission.status;
    const changed = remoteStatus !== submission.status;

    if (changed) {
      await db
        .update(docusealSubmissions)
        .set({
          status: remoteStatus,
          completedAt: remote.status === 'completed' ? new Date() : submission.completedAt,
          updatedAt: new Date(),
        })
        .where(eq(docusealSubmissions.id, submission.id));

      await db.insert(docusealAudit).values({
        submissionId: submission.id,
        eventType: 'reconciliation_correction',
        eventPayload: { before: submission.status, after: remoteStatus, source: 'manual_refresh' },
      });
    }

    res.json({ changed, before: submission.status, after: remoteStatus });
  });

  // ── POST /api/v1/docuseal/submissions/:id/resend ──────────────────────────

  router.post('/:id/resend', async (req, res): Promise<void> => {
    const [submission] = await db
      .select()
      .from(docusealSubmissions)
      .where(and(eq(docusealSubmissions.id, req.params['id']!), eq(docusealSubmissions.orgId, req.auth.org_id)))
      .limit(1);

    if (!submission) { res.status(404).json({ error: 'submission_not_found' }); return; }

    const config = await getActiveConfig(db, req.auth.org_id);
    if (!config) { res.status(422).json({ error: 'docuseal_not_configured' }); return; }

    const client = createDocusealClient({
      apiToken: config.apiToken,
      orgId: req.auth.org_id,
      mode: config.mode as 'saas' | 'self_hosted',
      endpointUrl: config.endpointUrl,
    });

    try {
      await client.resendSubmission(submission.docusealId);
    } catch (err) {
      res.status(502).json({ error: 'docuseal_api_error' });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapRemoteStatus(remoteStatus: string): string {
  const map: Record<string, string> = {
    pending: 'sent',
    completed: 'signed',
    declined: 'declined',
    expired: 'expired',
  };
  return map[remoteStatus] ?? remoteStatus;
}
