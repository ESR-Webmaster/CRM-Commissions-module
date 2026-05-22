import Decimal from 'decimal.js';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index';
import {
  auditLog,
  commissionEvents,
  commissionPlans,
  orgs,
  overrideRules,
  planAssignments,
  projectCommissionConfigs,
} from '../db/schema/index';
import { calcPercentContract, calcPpw } from './calculators/index';
import { InvalidProjectConfigError, NotImplementedError } from './errors';
import type {
  CommissionEventRow,
  EngineResult,
  Logger,
  PreviewInput,
  PreviewResult,
  StageTransitionInput,
} from './types';

type NewEvent = typeof commissionEvents.$inferInsert;
type SelectedEvent = typeof commissionEvents.$inferSelect;

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/**
 * Processes a stage transition from Sunscape: calculates commissions, writes events, handles
 * clawbacks and overrides. All writes happen in a single transaction; idempotent on transition_id.
 */
export async function processStageTransition(
  input: StageTransitionInput,
  db: Db,
  logger: Logger
): Promise<EngineResult> {
  const result: EngineResult = { events_created: [], events_already_existed: [] };

  // Look up project config — if missing, project isn't configured for commissions yet
  const [config] = await db
    .select()
    .from(projectCommissionConfigs)
    .where(
      and(
        eq(projectCommissionConfigs.projectId, input.project_id),
        eq(projectCommissionConfigs.orgId, input.org_id)
      )
    )
    .limit(1);

  if (!config) {
    logger.debug({ projectId: input.project_id }, 'no project config found, returning empty');
    return result;
  }

  // Validate money fields before touching the DB
  const contractVal = new Decimal(config.contractValue ?? '0');
  const systemSizeKwVal = new Decimal(config.systemSizeKw ?? '0');
  if (contractVal.lte(0)) {
    throw new InvalidProjectConfigError(input.project_id, 'contract_value must be positive');
  }
  if (systemSizeKwVal.lte(0)) {
    throw new InvalidProjectConfigError(input.project_id, 'system_size_kw must be positive');
  }

  await db.transaction(async (tx) => {
    // ── Org settings ─────────────────────────────────────────────────────────
    const [org] = await tx.select().from(orgs).where(eq(orgs.id, input.org_id)).limit(1);
    const requireApproval = org?.settings?.require_event_approval ?? false;
    const defaultStatus: 'pending' | 'approved' = requireApproval ? 'pending' : 'approved';

    // ── Inner helpers using the captured tx ──────────────────────────────────

    async function upsertEvent(values: NewEvent): Promise<{ row: SelectedEvent; existed: boolean }> {
      const inserted = await tx
        .insert(commissionEvents)
        .values(values)
        .onConflictDoNothing()
        .returning();

      if (inserted.length > 0) {
        return { row: inserted[0]!, existed: false };
      }

      // Unique constraint hit — return the existing row
      const [existing] = await tx
        .select()
        .from(commissionEvents)
        .where(
          and(
            eq(
              commissionEvents.triggeringStageTransitionId,
              values.triggeringStageTransitionId!
            ),
            eq(commissionEvents.userId, values.userId),
            eq(commissionEvents.eventType, values.eventType)
          )
        )
        .limit(1);

      if (!existing) {
        throw new Error(
          `Unique constraint fired on (${values.triggeringStageTransitionId}, ${values.userId}, ${values.eventType}) but row not found`
        );
      }

      logger.debug({ eventId: existing.id, eventType: values.eventType }, 'idempotent replay');
      return { row: existing, existed: true };
    }

    async function writeAuditLog(row: SelectedEvent) {
      await tx.insert(auditLog).values({
        orgId: input.org_id,
        actorUserId: SYSTEM_ACTOR,
        entityType: 'commission_event',
        entityId: row.id,
        action: 'created',
        before: null,
        after: row,
      });
    }

    function recordEvent(row: SelectedEvent, existed: boolean) {
      const cast = row as unknown as CommissionEventRow;
      if (existed) {
        result.events_already_existed.push(cast);
      } else {
        result.events_created.push(cast);
      }
    }

    // ── Step 1: earned events ────────────────────────────────────────────────
    // Track which plan IDs touched this project so we can run clawback pass later
    const touchedPlanIds = new Set<string>();
    const newlyEarnedRows: SelectedEvent[] = [];

    for (const rep of config.repAssignments) {
      // Resolve plan: project override takes priority over assignment
      let plan: typeof commissionPlans.$inferSelect | undefined;

      if (config.planOverrideId) {
        const [p] = await tx
          .select()
          .from(commissionPlans)
          .where(
            and(
              eq(commissionPlans.id, config.planOverrideId),
              eq(commissionPlans.isActive, true)
            )
          )
          .limit(1);
        plan = p;
      } else {
        // Find active plan assignment for this rep at the time the event occurred
        const [assignment] = await tx
          .select()
          .from(planAssignments)
          .where(
            and(
              eq(planAssignments.orgId, input.org_id),
              eq(planAssignments.userId, rep.user_id),
              eq(planAssignments.role, rep.role),
              lte(planAssignments.effectiveFrom, input.occurred_at),
              or(
                isNull(planAssignments.effectiveTo),
                gte(planAssignments.effectiveTo, input.occurred_at)
              )
            )
          )
          .limit(1);

        if (assignment) {
          const [p] = await tx
            .select()
            .from(commissionPlans)
            .where(eq(commissionPlans.id, assignment.planId))
            .limit(1);
          plan = p;
        }
      }

      if (!plan) {
        logger.warn(
          { userId: rep.user_id, projectId: input.project_id },
          'no plan resolved for rep, skipping'
        );
        continue;
      }

      touchedPlanIds.add(plan.id);

      if (input.to_stage !== plan.earnedTriggerStage) {
        logger.debug(
          { toStage: input.to_stage, earnedTrigger: plan.earnedTriggerStage },
          'stage is not earned trigger'
        );
        continue;
      }

      // Calculate commission amount
      const splitStr = String(rep.split_percent);
      let amount: Decimal;
      let explanation: string;

      if (plan.calculationType === 'percent_contract') {
        ({ amount, explanation } = calcPercentContract(
          plan.id,
          plan.rules,
          config.contractValue,
          splitStr
        ));
      } else if (plan.calculationType === 'ppw') {
        ({ amount, explanation } = calcPpw(plan.id, plan.rules, config.systemSizeKw, splitStr));
      } else {
        throw new NotImplementedError(`calculation_type: ${plan.calculationType}`);
      }

      logger.debug(
        { userId: rep.user_id, amount: amount.toFixed(2), explanation },
        'calculated earned commission'
      );

      const { row, existed } = await upsertEvent({
        orgId: input.org_id,
        projectId: input.project_id,
        userId: rep.user_id,
        planId: plan.id,
        eventType: 'earned',
        amount: amount.toFixed(2),
        triggeringStageTransitionId: input.transition_id,
        deliveryId: input.delivery_id,
        status: defaultStatus,
        notes: explanation,
        createdBy: SYSTEM_ACTOR,
      });

      recordEvent(row, existed);

      if (!existed) {
        await writeAuditLog(row);
        newlyEarnedRows.push(row);
      }
    }

    // ── Step 2: override_earned events ───────────────────────────────────────
    for (const earnedRow of newlyEarnedRows) {
      // Find override rules where this rep is in team_member_user_ids
      const applicableRules = await tx
        .select()
        .from(overrideRules)
        .where(
          and(
            eq(overrideRules.orgId, input.org_id),
            sql`${overrideRules.teamMemberUserIds} @> ARRAY[${earnedRow.userId}::uuid]`,
            lte(overrideRules.effectiveFrom, input.occurred_at),
            or(
              isNull(overrideRules.effectiveTo),
              gte(overrideRules.effectiveTo, input.occurred_at)
            )
          )
        );

      // Filter to rules that apply to this plan
      const filtered = applicableRules.filter(
        (r) =>
          r.appliesToPlanIds === null ||
          r.appliesToPlanIds.length === 0 ||
          r.appliesToPlanIds.includes(earnedRow.planId)
      );

      if (filtered.length === 0) continue;

      // Group by manager; pick most specific rule (has appliesToPlanIds) over general
      const byManager = new Map<string, (typeof filtered)[0]>();
      for (const rule of filtered) {
        const prior = byManager.get(rule.managerUserId);
        if (!prior) {
          byManager.set(rule.managerUserId, rule);
          continue;
        }
        const priorSpecific = prior.appliesToPlanIds && prior.appliesToPlanIds.length > 0;
        const ruleSpecific = rule.appliesToPlanIds && rule.appliesToPlanIds.length > 0;
        if (ruleSpecific && !priorSpecific) {
          byManager.set(rule.managerUserId, rule);
        }
        // Tie stays with first encountered
      }

      for (const [managerUserId, rule] of byManager.entries()) {
        const overrideAmt = new Decimal(earnedRow.amount)
          .mul(rule.overridePercent)
          .div(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

        const { row, existed } = await upsertEvent({
          orgId: input.org_id,
          projectId: input.project_id,
          userId: managerUserId,
          planId: earnedRow.planId,
          eventType: 'override_earned',
          amount: overrideAmt.toFixed(2),
          triggeringStageTransitionId: input.transition_id,
          deliveryId: input.delivery_id,
          status: defaultStatus,
          notes: `Override ${rule.overridePercent}% of $${earnedRow.amount} earned by ${earnedRow.userId}`,
          createdBy: SYSTEM_ACTOR,
        });

        recordEvent(row, existed);
        if (!existed) await writeAuditLog(row);
      }
    }

    // ── Step 3: clawback events ──────────────────────────────────────────────
    // Also consider the plan override even if no reps hit earned trigger
    if (config.planOverrideId) touchedPlanIds.add(config.planOverrideId);

    for (const planId of touchedPlanIds) {
      const [plan] = await tx
        .select()
        .from(commissionPlans)
        .where(eq(commissionPlans.id, planId))
        .limit(1);

      if (!plan?.clawbackConfig?.enabled) continue;

      const { cancellation_stages, clawback_percent, grace_period_days } = plan.clawbackConfig;
      if (!cancellation_stages.includes(input.to_stage)) continue;

      // Find prior earned/override_earned events for this project under this plan
      const priorEvents = await tx
        .select()
        .from(commissionEvents)
        .where(
          and(
            eq(commissionEvents.projectId, input.project_id),
            eq(commissionEvents.planId, planId),
            inArray(commissionEvents.eventType, ['earned', 'override_earned'])
          )
        );

      for (const prior of priorEvents) {
        const ageDays =
          (input.occurred_at.getTime() - prior.createdAt.getTime()) / (1000 * 60 * 60 * 24);

        if (ageDays > grace_period_days) {
          logger.debug(
            { eventId: prior.id, ageDays, grace_period_days },
            'past grace period, no clawback'
          );
          continue;
        }

        const clawbackAmt = new Decimal(prior.amount)
          .mul(clawback_percent)
          .div(100)
          .neg()
          .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

        const { row, existed } = await upsertEvent({
          orgId: input.org_id,
          projectId: input.project_id,
          userId: prior.userId,
          planId,
          eventType: 'clawed_back',
          amount: clawbackAmt.toFixed(2),
          triggeringStageTransitionId: input.transition_id,
          deliveryId: input.delivery_id,
          status: defaultStatus,
          notes: `Clawback ${clawback_percent}% of event ${prior.id}`,
          createdBy: SYSTEM_ACTOR,
        });

        recordEvent(row, existed);
        if (!existed) await writeAuditLog(row);
      }
    }
  });

  return result;
}

/**
 * Dry-run: returns what commissions WOULD be created if the project advanced to
 * hypothetical_stage. Reads only — no DB writes.
 */
export async function previewProjectedCommission(
  input: PreviewInput,
  db: Db,
  logger: Logger
): Promise<PreviewResult> {
  const would_create: PreviewResult['would_create'] = [];

  const [config] = await db
    .select()
    .from(projectCommissionConfigs)
    .where(
      and(
        eq(projectCommissionConfigs.projectId, input.project_id),
        eq(projectCommissionConfigs.orgId, input.org_id)
      )
    )
    .limit(1);

  if (!config) {
    logger.debug({ projectId: input.project_id }, 'no project config for preview');
    return { would_create };
  }

  const now = new Date();

  for (const rep of config.repAssignments) {
    let plan: typeof commissionPlans.$inferSelect | undefined;

    if (config.planOverrideId) {
      const [p] = await db
        .select()
        .from(commissionPlans)
        .where(eq(commissionPlans.id, config.planOverrideId))
        .limit(1);
      plan = p;
    } else {
      const [assignment] = await db
        .select()
        .from(planAssignments)
        .where(
          and(
            eq(planAssignments.orgId, input.org_id),
            eq(planAssignments.userId, rep.user_id),
            eq(planAssignments.role, rep.role),
            lte(planAssignments.effectiveFrom, now),
            or(isNull(planAssignments.effectiveTo), gte(planAssignments.effectiveTo, now))
          )
        )
        .limit(1);

      if (assignment) {
        const [p] = await db
          .select()
          .from(commissionPlans)
          .where(eq(commissionPlans.id, assignment.planId))
          .limit(1);
        plan = p;
      }
    }

    if (!plan || plan.earnedTriggerStage !== input.hypothetical_stage) continue;

    const splitStr = String(rep.split_percent);
    let amount: Decimal;
    let explanation: string;

    if (plan.calculationType === 'percent_contract') {
      ({ amount, explanation } = calcPercentContract(
        plan.id,
        plan.rules,
        config.contractValue,
        splitStr
      ));
    } else if (plan.calculationType === 'ppw') {
      ({ amount, explanation } = calcPpw(plan.id, plan.rules, config.systemSizeKw, splitStr));
    } else {
      throw new NotImplementedError(`calculation_type: ${plan.calculationType}`);
    }

    would_create.push({
      user_id: rep.user_id,
      plan_id: plan.id,
      event_type: 'earned',
      amount: amount.toNumber(),
      calculation_explanation: explanation,
    });
  }

  return { would_create };
}
