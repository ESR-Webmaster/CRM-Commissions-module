import { Router } from 'express';
import { eq, and, desc, count, gte, lte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index';
import { commissionEvents } from '../db/schema/events';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';

const listEventsQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'approved', 'paid', 'disputed']).optional(),
  event_type: z.enum(['earned', 'adjusted', 'clawed_back', 'override_earned', 'adder', 'deduction']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const patchStatusSchema = z.object({
  status: z.enum(['approved', 'disputed', 'paid']),
  notes: z.string().optional(),
});

const bulkStatusSchema = z.object({
  event_ids: z.array(z.string().uuid()).min(1).max(200),
  status: z.enum(['approved', 'disputed', 'paid']),
  notes: z.string().optional(),
});

function periodStart(unit: 'month' | 'quarter' | 'year'): Date {
  const now = new Date();
  if (unit === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (unit === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    return new Date(now.getFullYear(), q * 3, 1);
  }
  return new Date(now.getFullYear(), 0, 1);
}

export function createEventsRouter(db: Db): Router {
  const router = Router();

  // ── GET /api/v1/events ──────────────────────────────────────────────────────

  router.get('/', async (req, res): Promise<void> => {
    const parsed = listEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { user_id, project_id, status, event_type, from, to, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [eq(commissionEvents.orgId, req.auth.org_id)];
    if (user_id) conditions.push(eq(commissionEvents.userId, user_id));
    if (project_id) conditions.push(eq(commissionEvents.projectId, project_id));
    if (status) conditions.push(eq(commissionEvents.status, status));
    if (event_type) conditions.push(eq(commissionEvents.eventType, event_type));
    if (from) conditions.push(gte(commissionEvents.createdAt, new Date(from)));
    if (to) conditions.push(lte(commissionEvents.createdAt, new Date(to)));

    const where = and(...conditions);
    const [rows, totalRows] = await Promise.all([
      db.select().from(commissionEvents).where(where).orderBy(desc(commissionEvents.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(commissionEvents).where(where),
    ]);

    res.json({ events: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  // ── PATCH /api/v1/events/:id/status ────────────────────────────────────────

  router.patch('/:id/status', requireAdmin, async (req, res): Promise<void> => {
    const eventId = req.params['id']!;
    const parsed = patchStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [existing] = await db
      .select()
      .from(commissionEvents)
      .where(and(eq(commissionEvents.id, eventId), eq(commissionEvents.orgId, req.auth.org_id)));

    if (!existing) {
      res.status(404).json({ error: 'event_not_found' });
      return;
    }

    // Immutable ledger — only status is writable
    await db
      .update(commissionEvents)
      .set({ status: parsed.data.status })
      .where(eq(commissionEvents.id, eventId));

    const [updated] = await db.select().from(commissionEvents).where(eq(commissionEvents.id, eventId));

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'commission_event',
      entityId: eventId,
      action: `event_${parsed.data.status}`,
      before: existing,
      after: updated,
    });

    res.json(updated);
  });

  // ── POST /api/v1/events/bulk-status ────────────────────────────────────────

  router.post('/bulk-status', requireAdmin, async (req, res): Promise<void> => {
    const parsed = bulkStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const { event_ids, status, notes } = parsed.data;

    // Verify all events belong to this org
    const existingEvents = await db
      .select({ id: commissionEvents.id })
      .from(commissionEvents)
      .where(and(inArray(commissionEvents.id, event_ids), eq(commissionEvents.orgId, req.auth.org_id)));

    if (existingEvents.length !== event_ids.length) {
      res.status(422).json({ error: 'some_events_not_found_or_wrong_org' });
      return;
    }

    await db
      .update(commissionEvents)
      .set({ status })
      .where(inArray(commissionEvents.id, event_ids));

    const auditRows = event_ids.map((id) => ({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'commission_event' as const,
      entityId: id,
      action: `event_${status}`,
      before: null,
      after: { status, notes },
    }));
    await db.insert(auditLog).values(auditRows);

    res.json({ updated: event_ids.length, status });
  });

  // ── POST /api/v1/events/:id/dispute ────────────────────────────────────────

  router.post('/:id/dispute', async (req, res): Promise<void> => {
    const eventId = req.params['id']!;
    const { notes } = z.object({ notes: z.string().min(1) }).parse(req.body);

    const [existing] = await db
      .select()
      .from(commissionEvents)
      .where(
        and(
          eq(commissionEvents.id, eventId),
          eq(commissionEvents.orgId, req.auth.org_id),
          eq(commissionEvents.userId, req.auth.user_id)
        )
      );

    if (!existing) {
      res.status(404).json({ error: 'event_not_found' });
      return;
    }

    await db.update(commissionEvents).set({ status: 'disputed' }).where(eq(commissionEvents.id, eventId));

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'commission_event',
      entityId: eventId,
      action: 'event_disputed',
      before: existing,
      after: { ...existing, status: 'disputed', notes },
    });

    res.json({ id: eventId, status: 'disputed' });
  });

  // ── GET /api/v1/me/dashboard ────────────────────────────────────────────────

  router.get('/me/dashboard', async (req, res): Promise<void> => {
    const userId = req.auth.user_id;
    const orgId = req.auth.org_id;

    const [mtdRows, qtdRows, ytdRows, allRows] = await Promise.all([
      db.select({ total: sql<string>`SUM(amount)`, count: count() })
        .from(commissionEvents)
        .where(and(
          eq(commissionEvents.orgId, orgId),
          eq(commissionEvents.userId, userId),
          inArray(commissionEvents.status, ['approved', 'paid']),
          gte(commissionEvents.createdAt, periodStart('month'))
        )),
      db.select({ total: sql<string>`SUM(amount)`, count: count() })
        .from(commissionEvents)
        .where(and(
          eq(commissionEvents.orgId, orgId),
          eq(commissionEvents.userId, userId),
          inArray(commissionEvents.status, ['approved', 'paid']),
          gte(commissionEvents.createdAt, periodStart('quarter'))
        )),
      db.select({ total: sql<string>`SUM(amount)`, count: count() })
        .from(commissionEvents)
        .where(and(
          eq(commissionEvents.orgId, orgId),
          eq(commissionEvents.userId, userId),
          inArray(commissionEvents.status, ['approved', 'paid']),
          gte(commissionEvents.createdAt, periodStart('year'))
        )),
      db.select({ status: commissionEvents.status, total: sql<string>`SUM(amount)`, count: count() })
        .from(commissionEvents)
        .where(and(eq(commissionEvents.orgId, orgId), eq(commissionEvents.userId, userId)))
        .groupBy(commissionEvents.status),
    ]);

    const byStatus: Record<string, { total: string; count: number }> = {};
    for (const row of allRows) {
      byStatus[row.status] = { total: row.total ?? '0', count: row.count };
    }

    res.json({
      mtd: { total: mtdRows[0]?.total ?? '0', count: mtdRows[0]?.count ?? 0 },
      qtd: { total: qtdRows[0]?.total ?? '0', count: qtdRows[0]?.count ?? 0 },
      ytd: { total: ytdRows[0]?.total ?? '0', count: ytdRows[0]?.count ?? 0 },
      by_status: byStatus,
    });
  });

  // ── GET /api/v1/me/events ───────────────────────────────────────────────────

  router.get('/me/events', async (req, res): Promise<void> => {
    const parsed = listEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { status, event_type, from, to, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [
      eq(commissionEvents.orgId, req.auth.org_id),
      eq(commissionEvents.userId, req.auth.user_id),
    ];
    if (status) conditions.push(eq(commissionEvents.status, status));
    if (event_type) conditions.push(eq(commissionEvents.eventType, event_type));
    if (from) conditions.push(gte(commissionEvents.createdAt, new Date(from)));
    if (to) conditions.push(lte(commissionEvents.createdAt, new Date(to)));

    const where = and(...conditions);
    const [rows, totalRows] = await Promise.all([
      db.select().from(commissionEvents).where(where).orderBy(desc(commissionEvents.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(commissionEvents).where(where),
    ]);

    res.json({ events: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  return router;
}
