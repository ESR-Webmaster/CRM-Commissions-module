import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/index';
import { docusealConfig } from '../../db/schema/docuseal';
import { auditLog } from '../../db/schema/audit';
import { requireAdmin } from '../../middleware/auth';
import { createDocusealClient } from '../../services/docuseal/client';
import { seedStarterTemplates } from '../../services/docuseal/seedTemplates';

const upsertConfigSchema = z.object({
  mode: z.enum(['saas', 'self_hosted']),
  // For SaaS, endpoint_url is optional (defaults to DocuSeal's public API)
  endpoint_url: z.string().url().optional(),
  api_token: z.string().min(1),
  webhook_secret: z.string().min(1),
});

const patchDefaultsSchema = z.object({
  reminder_cadence: z.enum(['off', '48h_96h', 'daily']).optional(),
  expiration_days: z.number().int().min(1).max(365).optional(),
  delivery_channel: z.enum(['email', 'sms', 'both']).optional(),
});

export function createDocusealConfigRouter(db: Db): Router {
  const router = Router();

  // All config routes require admin
  router.use(requireAdmin);

  // ── GET /api/v1/docuseal/config ───────────────────────────────────────────
  // Returns the active config for the org. Never returns the credentials.

  router.get('/', async (req, res): Promise<void> => {
    const [config] = await db
      .select({
        id: docusealConfig.id,
        mode: docusealConfig.mode,
        endpointUrl: docusealConfig.endpointUrl,
        isActive: docusealConfig.isActive,
        lastHealthAt: docusealConfig.lastHealthAt,
        createdAt: docusealConfig.createdAt,
        updatedAt: docusealConfig.updatedAt,
      })
      .from(docusealConfig)
      .where(and(eq(docusealConfig.orgId, req.auth.org_id), eq(docusealConfig.isActive, true)))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: 'docuseal_not_configured' });
      return;
    }

    res.json(config);
  });

  // ── POST /api/v1/docuseal/config ──────────────────────────────────────────
  // Creates or replaces the active config. Deactivates any existing active config first.

  router.post('/', async (req, res): Promise<void> => {
    const parsed = upsertConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const { mode, endpoint_url, api_token, webhook_secret } = parsed.data;
    const endpointUrl =
      endpoint_url ?? (mode === 'saas' ? 'https://api.docuseal.com' : '');

    if (mode === 'self_hosted' && !endpoint_url) {
      res.status(400).json({ error: 'invalid_request', details: 'endpoint_url is required for self_hosted mode' });
      return;
    }

    // Deactivate any existing active config for this org
    await db
      .update(docusealConfig)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(docusealConfig.orgId, req.auth.org_id), eq(docusealConfig.isActive, true)));

    const rows = await db
      .insert(docusealConfig)
      .values({
        orgId: req.auth.org_id,
        mode,
        endpointUrl,
        apiToken: api_token,
        webhookSecret: webhook_secret,
        isActive: true,
      })
      .returning({
        id: docusealConfig.id,
        mode: docusealConfig.mode,
        endpointUrl: docusealConfig.endpointUrl,
        isActive: docusealConfig.isActive,
        lastHealthAt: docusealConfig.lastHealthAt,
        createdAt: docusealConfig.createdAt,
        updatedAt: docusealConfig.updatedAt,
      });

    const created = rows[0];
    if (!created) {
      res.status(500).json({ error: 'insert_failed' });
      return;
    }

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'docuseal_config',
      entityId: created.id,
      action: 'created',
      before: null,
      after: { mode, endpointUrl },
    });

    // Fire-and-forget starter template seeding on first connection
    const client = createDocusealClient({
      apiToken: api_token,
      orgId: req.auth.org_id,
      mode,
      endpointUrl,
    });
    seedStarterTemplates({ db, client, orgId: req.auth.org_id }).catch(() => {
      // Non-fatal — templates can be seeded manually later
    });

    res.status(201).json(created);
  });

  // ── PATCH /api/v1/docuseal/config/defaults ────────────────────────────────
  // Update per-org sending defaults (reminder cadence, expiry, delivery channel).

  router.patch('/defaults', requireAdmin, async (req, res): Promise<void> => {
    const parsed = patchDefaultsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [config] = await db
      .select()
      .from(docusealConfig)
      .where(and(eq(docusealConfig.orgId, req.auth.org_id), eq(docusealConfig.isActive, true)))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: 'docuseal_not_configured' });
      return;
    }

    const current = config.defaults ?? {};
    const updated = {
      ...current,
      ...(parsed.data.reminder_cadence !== undefined && { reminderCadence: parsed.data.reminder_cadence }),
      ...(parsed.data.expiration_days !== undefined && { expirationDays: parsed.data.expiration_days }),
      ...(parsed.data.delivery_channel !== undefined && { deliveryChannel: parsed.data.delivery_channel }),
    };

    await db
      .update(docusealConfig)
      .set({ defaults: updated, updatedAt: new Date() })
      .where(eq(docusealConfig.id, config.id));

    res.json({ defaults: updated });
  });

  // ── POST /api/v1/docuseal/config/test ─────────────────────────────────────
  // Runs a ping against the stored active config. Does not require credentials in body.

  router.post('/test', async (req, res): Promise<void> => {
    const [config] = await db
      .select()
      .from(docusealConfig)
      .where(and(eq(docusealConfig.orgId, req.auth.org_id), eq(docusealConfig.isActive, true)))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: 'docuseal_not_configured' });
      return;
    }

    const client = createDocusealClient({
      apiToken: config.apiToken,
      orgId: req.auth.org_id,
      mode: config.mode as 'saas' | 'self_hosted',
      endpointUrl: config.endpointUrl,
    });

    const result = await client.ping();

    if (result.ok) {
      await db
        .update(docusealConfig)
        .set({ lastHealthAt: new Date(), updatedAt: new Date() })
        .where(eq(docusealConfig.id, config.id));
    }

    res.json(result);
  });

  return router;
}
