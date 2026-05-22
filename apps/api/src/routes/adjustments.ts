import { Router } from 'express';
import { eq, and, desc, count } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index';
import { commissionAdjustments } from '../db/schema/adjustments';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';

const createAdjustmentSchema = z.object({
  project_id: z.string().uuid(),
  user_id: z.string().uuid(),
  amount: z.number(),
  reason: z.enum(['redesign', 'change_order', 'bonus', 'penalty', 'manual']),
  notes: z.string().optional(),
});

const listAdjustmentsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export function createAdjustmentsRouter(db: Db): Router {
  const router = Router();

  router.get('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = listAdjustmentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { project_id, user_id, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [eq(commissionAdjustments.orgId, req.auth.org_id)];
    if (project_id) conditions.push(eq(commissionAdjustments.projectId, project_id));
    if (user_id) conditions.push(eq(commissionAdjustments.userId, user_id));

    const where = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db.select().from(commissionAdjustments).where(where).orderBy(desc(commissionAdjustments.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(commissionAdjustments).where(where),
    ]);

    res.json({ adjustments: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  router.post('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = createAdjustmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }
    const { project_id, user_id, amount, reason, notes } = parsed.data;

    const [row] = await db
      .insert(commissionAdjustments)
      .values({
        orgId: req.auth.org_id,
        projectId: project_id,
        userId: user_id,
        amount: String(amount),
        reason,
        notes: notes ?? null,
        createdBy: req.auth.user_id,
      })
      .returning();

    if (row) {
      await db.insert(auditLog).values({
        orgId: req.auth.org_id,
        actorUserId: req.auth.user_id,
        entityType: 'adjustment',
        entityId: row.id,
        action: 'created',
        after: row,
      });
    }

    res.status(201).json(row);
  });

  return router;
}
