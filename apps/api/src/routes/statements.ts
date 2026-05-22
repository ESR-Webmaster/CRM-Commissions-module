import { Router } from 'express';
import { eq, and, desc, count, gte, lte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index';
import { payoutStatements } from '../db/schema/statements';
import { commissionEvents } from '../db/schema/events';
import { commissionPlans } from '../db/schema/plans';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';

const generateStatementSchema = z.object({
  rep_user_id: z.string().uuid(),
  period_start: z.string().datetime({ offset: true }),
  period_end: z.string().datetime({ offset: true }),
});

const listStatementsQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
  status: z.enum(['draft', 'approved', 'paid']).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export function createStatementsRouter(db: Db): Router {
  const router = Router();

  // ── GET /api/v1/statements ─────────────────────────────────────────────────

  router.get('/', async (req, res): Promise<void> => {
    const parsed = listStatementsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { user_id, status, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [eq(payoutStatements.orgId, req.auth.org_id)];
    if (req.auth.role !== 'admin') {
      conditions.push(eq(payoutStatements.userId, req.auth.user_id));
    } else if (user_id) {
      conditions.push(eq(payoutStatements.userId, user_id));
    }
    if (status) conditions.push(eq(payoutStatements.status, status));

    const where = and(...conditions);
    const [rows, totalRows] = await Promise.all([
      db.select().from(payoutStatements).where(where).orderBy(desc(payoutStatements.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(payoutStatements).where(where),
    ]);

    res.json({ statements: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  // ── POST /api/v1/statements/generate (admin) ──────────────────────────────

  router.post('/generate', requireAdmin, async (req, res): Promise<void> => {
    const parsed = generateStatementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }
    const { rep_user_id, period_start, period_end } = parsed.data;
    const start = new Date(period_start);
    const end = new Date(period_end);

    if (start >= end) {
      res.status(400).json({ error: 'invalid_period', message: 'period_start must be before period_end' });
      return;
    }

    // Gather approved/paid events for this rep in the period that aren't already in a statement
    const eligibleEvents = await db
      .select()
      .from(commissionEvents)
      .where(
        and(
          eq(commissionEvents.orgId, req.auth.org_id),
          eq(commissionEvents.userId, rep_user_id),
          inArray(commissionEvents.status, ['approved', 'paid']),
          gte(commissionEvents.createdAt, start),
          lte(commissionEvents.createdAt, end)
        )
      );

    if (eligibleEvents.length === 0) {
      res.status(422).json({ error: 'no_eligible_events', message: 'No approved/paid events in the specified period for this rep' });
      return;
    }

    // Check none are already locked in an approved/paid statement
    const eventIds = eligibleEvents.map((e) => e.id);
    const existingStatements = await db
      .select()
      .from(payoutStatements)
      .where(
        and(
          eq(payoutStatements.orgId, req.auth.org_id),
          inArray(payoutStatements.status, ['approved', 'paid'])
        )
      );

    const lockedEventIds = new Set<string>();
    for (const s of existingStatements) {
      for (const id of s.eventIds) lockedEventIds.add(id);
    }

    const conflicted = eventIds.filter((id) => lockedEventIds.has(id));
    if (conflicted.length > 0) {
      res.status(422).json({ error: 'events_already_in_statement', conflicted });
      return;
    }

    // Calculate totals
    let totalEarned = 0;
    let totalClawedBack = 0;
    let totalAdjustments = 0;

    for (const ev of eligibleEvents) {
      const amt = Number(ev.amount);
      if (ev.eventType === 'earned' || ev.eventType === 'override_earned') {
        totalEarned += amt;
      } else if (ev.eventType === 'clawed_back') {
        totalClawedBack += amt;
      } else {
        totalAdjustments += amt;
      }
    }

    const netPayable = totalEarned - totalClawedBack + totalAdjustments;

    const [statement] = await db
      .insert(payoutStatements)
      .values({
        orgId: req.auth.org_id,
        userId: rep_user_id,
        periodStart: start,
        periodEnd: end,
        totalEarned: totalEarned.toFixed(2),
        totalClawedBack: totalClawedBack.toFixed(2),
        totalAdjustments: totalAdjustments.toFixed(2),
        netPayable: netPayable.toFixed(2),
        eventIds,
      })
      .returning();

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'payout_statement',
      entityId: statement!.id,
      action: 'statement_generated',
      before: null,
      after: statement,
    });

    res.status(201).json(statement);
  });

  // ── GET /api/v1/statements/:id ─────────────────────────────────────────────

  router.get('/:id', async (req, res): Promise<void> => {
    const [statement] = await db
      .select()
      .from(payoutStatements)
      .where(and(eq(payoutStatements.id, req.params['id']!), eq(payoutStatements.orgId, req.auth.org_id)));

    if (!statement) {
      res.status(404).json({ error: 'statement_not_found' });
      return;
    }

    if (req.auth.role !== 'admin' && statement.userId !== req.auth.user_id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // Fetch events for line items
    const events = statement.eventIds.length > 0
      ? await db
          .select()
          .from(commissionEvents)
          .where(inArray(commissionEvents.id, statement.eventIds))
      : [];

    res.json({ ...statement, line_items: events });
  });

  // ── POST /api/v1/statements/:id/approve (admin) ───────────────────────────

  router.post('/:id/approve', requireAdmin, async (req, res): Promise<void> => {
    const [existing] = await db
      .select()
      .from(payoutStatements)
      .where(and(eq(payoutStatements.id, req.params['id']!), eq(payoutStatements.orgId, req.auth.org_id)));

    if (!existing) {
      res.status(404).json({ error: 'statement_not_found' });
      return;
    }

    if (existing.status !== 'draft') {
      res.status(422).json({ error: 'statement_not_draft' });
      return;
    }

    const [updated] = await db
      .update(payoutStatements)
      .set({ status: 'approved', approvedBy: req.auth.user_id })
      .where(eq(payoutStatements.id, existing.id))
      .returning();

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'payout_statement',
      entityId: existing.id,
      action: 'statement_approved',
      before: existing,
      after: updated,
    });

    res.json(updated);
  });

  // ── POST /api/v1/statements/:id/mark-paid (admin) ─────────────────────────

  router.post('/:id/mark-paid', requireAdmin, async (req, res): Promise<void> => {
    const [existing] = await db
      .select()
      .from(payoutStatements)
      .where(and(eq(payoutStatements.id, req.params['id']!), eq(payoutStatements.orgId, req.auth.org_id)));

    if (!existing) {
      res.status(404).json({ error: 'statement_not_found' });
      return;
    }

    if (existing.status !== 'approved') {
      res.status(422).json({ error: 'statement_not_approved' });
      return;
    }

    // Mark events as paid
    if (existing.eventIds.length > 0) {
      await db
        .update(commissionEvents)
        .set({ status: 'paid' })
        .where(inArray(commissionEvents.id, existing.eventIds));
    }

    const [updated] = await db
      .update(payoutStatements)
      .set({ status: 'paid' })
      .where(eq(payoutStatements.id, existing.id))
      .returning();

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'payout_statement',
      entityId: existing.id,
      action: 'statement_paid',
      before: existing,
      after: updated,
    });

    res.json(updated);
  });

  // ── GET /api/v1/statements/:id/csv ────────────────────────────────────────

  router.get('/:id/csv', async (req, res): Promise<void> => {
    const [statement] = await db
      .select()
      .from(payoutStatements)
      .where(and(eq(payoutStatements.id, req.params['id']!), eq(payoutStatements.orgId, req.auth.org_id)));

    if (!statement) {
      res.status(404).json({ error: 'statement_not_found' });
      return;
    }

    if (req.auth.role !== 'admin' && statement.userId !== req.auth.user_id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const events = statement.eventIds.length > 0
      ? await db
          .select()
          .from(commissionEvents)
          .where(inArray(commissionEvents.id, statement.eventIds))
      : [];

    const planIds = [...new Set(events.map((e) => e.planId).filter((id): id is string => !!id))];
    const plans = planIds.length > 0
      ? await db
          .select({ id: commissionPlans.id, name: commissionPlans.name })
          .from(commissionPlans)
          .where(inArray(commissionPlans.id, planIds))
      : [];
    const planMap = new Map(plans.map((p) => [p.id, p.name]));

    const periodStart = statement.periodStart instanceof Date
      ? statement.periodStart.toISOString().slice(0, 10)
      : String(statement.periodStart).slice(0, 10);
    const periodEnd = statement.periodEnd instanceof Date
      ? statement.periodEnd.toISOString().slice(0, 10)
      : String(statement.periodEnd).slice(0, 10);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="statement-${statement.id.slice(0, 8)}.csv"`);

    res.write('rep_user_id,project_id,event_type,plan_name,amount,event_date,status,period_start,period_end\n');

    for (const ev of events) {
      const date = ev.createdAt instanceof Date
        ? ev.createdAt.toISOString()
        : String(ev.createdAt);
      const planName = ev.planId ? (planMap.get(ev.planId) ?? '') : '';
      res.write(
        [
          statement.userId,
          ev.projectId,
          ev.eventType,
          `"${planName.replace(/"/g, '""')}"`,
          ev.amount,
          date,
          ev.status,
          periodStart,
          periodEnd,
        ].join(',') + '\n'
      );
    }

    res.end();
  });

  return router;
}
