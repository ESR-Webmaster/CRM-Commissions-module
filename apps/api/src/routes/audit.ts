import { Router } from 'express';
import { eq, and, desc, count, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';

const listAuditQuerySchema = z.object({
  entity_type: z.string().optional(),
  entity_id: z.string().uuid().optional(),
  actor_user_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export function createAuditRouter(db: Db): Router {
  const router = Router();

  router.get('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = listAuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { entity_type, entity_id, actor_user_id, from, to, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [eq(auditLog.orgId, req.auth.org_id)];
    if (entity_type) conditions.push(eq(auditLog.entityType, entity_type));
    if (entity_id) conditions.push(eq(auditLog.entityId, entity_id));
    if (actor_user_id) conditions.push(eq(auditLog.actorUserId, actor_user_id));
    if (from) conditions.push(gte(auditLog.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLog.createdAt, new Date(to)));

    const where = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db.select().from(auditLog).where(where).orderBy(desc(auditLog.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(auditLog).where(where),
    ]);

    res.json({ entries: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  return router;
}
