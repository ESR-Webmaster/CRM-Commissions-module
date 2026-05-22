import { Router } from 'express';
import { eq, desc, and, count } from 'drizzle-orm';
import type { Db } from '../db/index';
import { commissionPlans } from '../db/schema/plans';
import { commissionEvents } from '../db/schema/events';
import { auditLog } from '../db/schema/audit';
import { requireAdmin } from '../middleware/auth';
import {
  createPlanSchema,
  updatePlanSchema,
  endAndReplaceSchema,
  listPlansQuerySchema,
} from '@sunscape/commissions-shared';

function isFuture(dateStr: string): boolean {
  return new Date(dateStr) > new Date();
}

function mapCreateInputToRow(input: ReturnType<typeof createPlanSchema.parse>, orgId: string) {
  return {
    orgId,
    name: input.name,
    calculationType: input.calculation_type,
    rules: input.rules,
    earnedTriggerStage: input.earned_trigger_stage,
    payableTrigger: input.payable_trigger,
    clawbackConfig: input.clawback_config ?? null,
    effectiveFrom: new Date(input.effective_from),
    effectiveTo: input.effective_to ? new Date(input.effective_to) : null,
    isActive: input.is_active ?? true,
  };
}

export function createPlansRouter(db: Db): Router {
  const router = Router();

  // ── GET /api/v1/plans ───────────────────────────────────────────────────────

  router.get('/', async (req, res): Promise<void> => {
    const parsed = listPlansQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { is_active, calculation_type, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [eq(commissionPlans.orgId, req.auth.org_id)];
    if (is_active !== undefined) {
      conditions.push(eq(commissionPlans.isActive, is_active === 'true'));
    }
    if (calculation_type !== undefined) {
      conditions.push(
        eq(commissionPlans.calculationType, calculation_type as typeof commissionPlans.calculationType._.data)
      );
    }

    const where = and(...conditions);
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(commissionPlans)
        .where(where)
        .orderBy(desc(commissionPlans.effectiveFrom))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(commissionPlans).where(where),
    ]);

    res.json({ plans: rows, total: totalRows[0]?.total ?? 0, page, limit });
  });

  // ── POST /api/v1/plans ──────────────────────────────────────────────────────

  router.post('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = createPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    if (!isFuture(parsed.data.effective_from)) {
      res.status(400).json({ error: 'effective_from_must_be_future' });
      return;
    }

    try {
      const [plan] = await db
        .insert(commissionPlans)
        .values(mapCreateInputToRow(parsed.data, req.auth.org_id))
        .returning();

      await db.insert(auditLog).values({
        orgId: req.auth.org_id,
        actorUserId: req.auth.user_id,
        entityType: 'commission_plan',
        entityId: plan!.id,
        action: 'plan_created',
        before: null,
        after: plan,
      });

      res.status(201).json(plan);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('idx_plans_active_name') || message.includes('unique')) {
        res.status(409).json({ error: 'plan_name_conflict' });
        return;
      }
      throw err;
    }
  });

  // ── PUT /api/v1/plans/:id ───────────────────────────────────────────────────

  router.put('/:id', requireAdmin, async (req, res): Promise<void> => {
    const planId = req.params['id']!;
    const parsed = updatePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [existing] = await db
      .select()
      .from(commissionPlans)
      .where(and(eq(commissionPlans.id, planId), eq(commissionPlans.orgId, req.auth.org_id)));

    if (!existing) {
      res.status(404).json({ error: 'plan_not_found' });
      return;
    }

    const input = parsed.data;
    const changingImmutable =
      ('calculation_type' in input && input.calculation_type !== undefined) ||
      ('rules' in input && input.rules !== undefined);

    if (changingImmutable) {
      const [eventCountRow] = await db
        .select({ eventCount: count() })
        .from(commissionEvents)
        .where(
          and(eq(commissionEvents.planId, planId), eq(commissionEvents.orgId, req.auth.org_id))
        );
      if ((eventCountRow?.eventCount ?? 0) > 0) {
        res.status(422).json({ error: 'plan_has_events_immutable_fields' });
        return;
      }
    }

    const updateValues: Partial<typeof existing> = {};
    if ('name' in input && input.name !== undefined) updateValues.name = input.name;
    if ('calculation_type' in input && input.calculation_type !== undefined)
      updateValues.calculationType = input.calculation_type;
    if ('rules' in input && input.rules !== undefined) updateValues.rules = input.rules;
    if ('earned_trigger_stage' in input && input.earned_trigger_stage !== undefined)
      updateValues.earnedTriggerStage = input.earned_trigger_stage;
    if ('payable_trigger' in input && input.payable_trigger !== undefined)
      updateValues.payableTrigger = input.payable_trigger;
    if ('clawback_config' in input && input.clawback_config !== undefined)
      updateValues.clawbackConfig = input.clawback_config;
    if ('effective_from' in input && input.effective_from !== undefined)
      updateValues.effectiveFrom = new Date(input.effective_from);
    if ('effective_to' in input && input.effective_to !== undefined)
      updateValues.effectiveTo = input.effective_to ? new Date(input.effective_to) : null;
    if ('is_active' in input && input.is_active !== undefined)
      updateValues.isActive = input.is_active;

    const [updated] = await db
      .update(commissionPlans)
      .set({ ...updateValues, updatedAt: new Date() })
      .where(and(eq(commissionPlans.id, planId), eq(commissionPlans.orgId, req.auth.org_id)))
      .returning();

    await db.insert(auditLog).values({
      orgId: req.auth.org_id,
      actorUserId: req.auth.user_id,
      entityType: 'commission_plan',
      entityId: planId,
      action: 'plan_updated',
      before: existing,
      after: updated,
    });

    res.json(updated);
  });

  // ── POST /api/v1/plans/:id/end-and-replace ──────────────────────────────────

  router.post('/:id/end-and-replace', requireAdmin, async (req, res): Promise<void> => {
    const planId = req.params['id']!;
    const parsed = endAndReplaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [existing] = await db
      .select()
      .from(commissionPlans)
      .where(and(eq(commissionPlans.id, planId), eq(commissionPlans.orgId, req.auth.org_id)));

    if (!existing) {
      res.status(404).json({ error: 'plan_not_found' });
      return;
    }

    const input = parsed.data;
    const endDate = 'end_date' in input && input.end_date ? new Date(input.end_date) : new Date();

    const result = await db.transaction(async (tx) => {
      // End the existing plan
      const [ended] = await tx
        .update(commissionPlans)
        .set({ effectiveTo: endDate, isActive: false, updatedAt: new Date() })
        .where(eq(commissionPlans.id, planId))
        .returning();

      // Build new plan from old plan merged with overrides
      const newPlanValues = {
        orgId: req.auth.org_id,
        name: ('name' in input && input.name) ? input.name : existing.name,
        calculationType:
          ('calculation_type' in input && input.calculation_type)
            ? input.calculation_type
            : existing.calculationType,
        rules:
          ('rules' in input && input.rules) ? input.rules : existing.rules,
        earnedTriggerStage:
          ('earned_trigger_stage' in input && input.earned_trigger_stage)
            ? input.earned_trigger_stage
            : existing.earnedTriggerStage,
        payableTrigger:
          ('payable_trigger' in input && input.payable_trigger)
            ? input.payable_trigger
            : existing.payableTrigger,
        clawbackConfig:
          ('clawback_config' in input && input.clawback_config !== undefined)
            ? input.clawback_config
            : existing.clawbackConfig,
        effectiveFrom: endDate,
        effectiveTo:
          ('effective_to' in input && input.effective_to !== undefined)
            ? (input.effective_to ? new Date(input.effective_to) : null)
            : null,
        isActive: true,
      };

      const [created] = await tx.insert(commissionPlans).values(newPlanValues).returning();

      await tx.insert(auditLog).values([
        {
          orgId: req.auth.org_id,
          actorUserId: req.auth.user_id,
          entityType: 'commission_plan',
          entityId: planId,
          action: 'plan_ended',
          before: existing,
          after: ended,
        },
        {
          orgId: req.auth.org_id,
          actorUserId: req.auth.user_id,
          entityType: 'commission_plan',
          entityId: created!.id,
          action: 'plan_created',
          before: null,
          after: created,
        },
      ]);

      return { ended, created };
    });

    res.status(201).json(result);
  });

  return router;
}
