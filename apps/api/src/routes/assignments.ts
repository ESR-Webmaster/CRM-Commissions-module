import { Router } from 'express';
import { eq, and, or, isNull, isNotNull, gte, lte, desc, count } from 'drizzle-orm';
import type { Db } from '../db/index';
import { planAssignments } from '../db/schema/assignments';
import { commissionPlans } from '../db/schema/plans';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';
import { createAssignmentSchema, listAssignmentsQuerySchema } from '@sunscape/commissions-shared';

export function createAssignmentsRouter(db: Db): Router {
  const router = Router();

  // ── GET /api/v1/plan-assignments ────────────────────────────────────────────

  router.get('/', async (req, res): Promise<void> => {
    const parsed = listAssignmentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { user_id, plan_id, is_active, page, limit } = parsed.data;
    const offset = (page - 1) * limit;
    const now = new Date();

    const conditions = [eq(planAssignments.orgId, req.auth.org_id)];
    if (user_id) conditions.push(eq(planAssignments.userId, user_id));
    if (plan_id) conditions.push(eq(planAssignments.planId, plan_id));
    if (is_active === 'true') {
      conditions.push(
        and(
          lte(planAssignments.effectiveFrom, now),
          or(isNull(planAssignments.effectiveTo), gte(planAssignments.effectiveTo, now))
        )!
      );
    } else if (is_active === 'false') {
      conditions.push(
        and(isNotNull(planAssignments.effectiveTo), lte(planAssignments.effectiveTo, now))!
      );
    }

    const where = and(...conditions);
    const [rows, totalRows] = await Promise.all([
      db.select().from(planAssignments).where(where).orderBy(desc(planAssignments.effectiveFrom)).limit(limit).offset(offset),
      db.select({ total: count() }).from(planAssignments).where(where),
    ]);

    res.json({ assignments: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  // ── POST /api/v1/plan-assignments ───────────────────────────────────────────

  router.post('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = createAssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const input = parsed.data;
    const effectiveFrom = new Date(input.effective_from);
    const effectiveTo = input.effective_to ? new Date(input.effective_to) : null;

    if (effectiveTo && effectiveTo <= effectiveFrom) {
      res.status(400).json({ error: 'effective_to_must_be_after_effective_from' });
      return;
    }

    // Verify the plan belongs to this org
    const [plan] = await db
      .select({ id: commissionPlans.id })
      .from(commissionPlans)
      .where(and(eq(commissionPlans.id, input.plan_id), eq(commissionPlans.orgId, req.auth.org_id)));

    if (!plan) {
      res.status(404).json({ error: 'plan_not_found' });
      return;
    }

    // Check for overlapping assignment with same user + role
    const endBound = effectiveTo ?? new Date('9999-12-31');
    const overlapping = await db
      .select({ id: planAssignments.id })
      .from(planAssignments)
      .where(
        and(
          eq(planAssignments.orgId, req.auth.org_id),
          eq(planAssignments.userId, input.user_id),
          eq(planAssignments.role, input.role),
          lte(planAssignments.effectiveFrom, endBound),
          or(isNull(planAssignments.effectiveTo), gte(planAssignments.effectiveTo, effectiveFrom))
        )
      )
      .limit(1);

    if (overlapping.length > 0) {
      res.status(409).json({ error: 'overlapping_assignment' });
      return;
    }

    const [row] = await db
      .insert(planAssignments)
      .values({
        planId: input.plan_id,
        orgId: req.auth.org_id,
        userId: input.user_id,
        role: input.role,
        defaultSplitPercent: String(input.default_split_percent),
        effectiveFrom,
        effectiveTo,
      })
      .returning();

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'plan_assignment',
      entityId: row!.id,
      action: 'assignment_created',
      before: null,
      after: row,
    });

    res.status(201).json(row);
  });

  // ── DELETE /api/v1/plan-assignments/:id ─────────────────────────────────────

  router.delete('/:id', requireAdmin, async (req, res): Promise<void> => {
    const assignmentId = req.params['id']!;

    const [existing] = await db
      .select()
      .from(planAssignments)
      .where(and(eq(planAssignments.id, assignmentId), eq(planAssignments.orgId, req.auth.org_id)));

    if (!existing) {
      res.status(404).json({ error: 'assignment_not_found' });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(planAssignments)
      .set({ effectiveTo: now })
      .where(eq(planAssignments.id, assignmentId))
      .returning();

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'plan_assignment',
      entityId: assignmentId,
      action: 'assignment_deactivated',
      before: existing,
      after: updated,
    });

    res.json(updated);
  });

  return router;
}
