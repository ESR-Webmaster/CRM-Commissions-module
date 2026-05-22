import { Router } from 'express';
import { eq, and, desc, count } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index';
import { overrideRules } from '../db/schema/overrides';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';

const createOverrideRuleSchema = z.object({
  manager_user_id: z.string().uuid(),
  team_member_user_ids: z.array(z.string().uuid()).min(1),
  override_percent: z.number().min(0).max(100),
  applies_to_plan_ids: z.array(z.string().uuid()).optional(),
  effective_from: z.string().datetime({ offset: true }),
  effective_to: z.string().datetime({ offset: true }).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export function createOverrideRulesRouter(db: Db): Router {
  const router = Router();

  router.get('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const where = eq(overrideRules.orgId, req.auth.org_id);

    const [rows, totalRows] = await Promise.all([
      db.select().from(overrideRules).where(where).orderBy(desc(overrideRules.effectiveFrom)).limit(limit).offset(offset),
      db.select({ total: count() }).from(overrideRules).where(where),
    ]);

    res.json({ rules: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  router.post('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = createOverrideRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }
    const { manager_user_id, team_member_user_ids, override_percent, applies_to_plan_ids, effective_from, effective_to } = parsed.data;

    const [row] = await db
      .insert(overrideRules)
      .values({
        orgId: req.auth.org_id,
        managerUserId: manager_user_id,
        teamMemberUserIds: team_member_user_ids,
        overridePercent: String(override_percent),
        appliesToPlanIds: applies_to_plan_ids ?? null,
        effectiveFrom: new Date(effective_from),
        effectiveTo: effective_to ? new Date(effective_to) : null,
      })
      .returning();

    if (row) {
      await db.insert(auditLog).values({
        orgId: req.auth.org_id,
        actorUserId: req.auth.user_id,
        entityType: 'override_rule',
        entityId: row.id,
        action: 'created',
        after: row,
      });
    }

    res.status(201).json(row);
  });

  router.delete('/:id', requireAdmin, async (req, res): Promise<void> => {
    const id = req.params['id']!;

    const [existing] = await db
      .select()
      .from(overrideRules)
      .where(and(eq(overrideRules.id, id), eq(overrideRules.orgId, req.auth.org_id)));

    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    await db.delete(overrideRules).where(eq(overrideRules.id, id));

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'override_rule',
      entityId: id,
      action: 'deleted',
      before: existing,
    });

    res.json({ id, deleted: true });
  });

  return router;
}
