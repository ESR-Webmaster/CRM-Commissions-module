import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { orgs } from '../db/schema/orgs';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';

const patchSettingsSchema = z.object({
  require_event_approval: z.boolean(),
});

export function createOrgsRouter(db: Db): Router {
  const router = Router();

  router.get('/me/settings', async (req, res): Promise<void> => {
    const [org] = await db
      .select({ settings: orgs.settings })
      .from(orgs)
      .where(eq(orgs.id, req.auth.org_id));

    if (!org) {
      res.status(404).json({ error: 'org_not_found' });
      return;
    }

    res.json({ require_event_approval: org.settings.require_event_approval ?? false });
  });

  router.patch('/me/settings', requireAdmin, async (req, res): Promise<void> => {
    const parsed = patchSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [existing] = await db
      .select({ id: orgs.id, settings: orgs.settings })
      .from(orgs)
      .where(eq(orgs.id, req.auth.org_id));

    if (!existing) {
      res.status(404).json({ error: 'org_not_found' });
      return;
    }

    const before = existing.settings;
    const after = { ...before, ...parsed.data };

    await db
      .update(orgs)
      .set({ settings: after })
      .where(eq(orgs.id, req.auth.org_id));

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'org',
      entityId: req.auth.org_id,
      action: 'settings_updated',
      before,
      after,
    });

    res.json({ require_event_approval: after.require_event_approval ?? false });
  });

  return router;
}
