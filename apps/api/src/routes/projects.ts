import { Router } from 'express';
import { eq, and, lte, gte, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index';
import { projectCommissionConfigs } from '../db/schema/projects';
import { users } from '../db/schema/users';
import { commissionPlans } from '../db/schema/plans';
import { planAssignments } from '../db/schema/assignments';
import { auditLog } from '../db/schema/audit';
import { upsertProjectSchema } from '@sunscape/commissions-shared';
import { calcPercentContract, calcPpw } from '../services/calculators/index';

export function createProjectsRouter(db: Db): Router {
  const router = Router();

  // ── POST /api/v1/projects (upsert) ──────────────────────────────────────────

  router.post('/', async (req, res): Promise<void> => {
    const parsed = upsertProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const input = parsed.data;

    // Validate all referenced user_ids exist in this org
    const userIds = input.rep_assignments.map((r) => r.user_id);
    const existingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.orgId, req.auth.org_id));
    const existingUserIds = new Set(existingUsers.map((u) => u.id));
    const missingUsers = userIds.filter((id) => !existingUserIds.has(id));
    if (missingUsers.length > 0) {
      res.status(422).json({ error: 'users_not_found', missing: missingUsers });
      return;
    }

    // Validate plan override if provided
    if (input.plan_override_id) {
      const [plan] = await db
        .select({ id: commissionPlans.id })
        .from(commissionPlans)
        .where(and(eq(commissionPlans.id, input.plan_override_id), eq(commissionPlans.orgId, req.auth.org_id)));
      if (!plan) {
        res.status(422).json({ error: 'plan_override_not_found' });
        return;
      }
    }

    // Upsert project config
    const [existing] = await db
      .select()
      .from(projectCommissionConfigs)
      .where(
        and(
          eq(projectCommissionConfigs.projectId, input.project_id),
          eq(projectCommissionConfigs.orgId, req.auth.org_id)
        )
      );

    const now = new Date();
    const values = {
      projectId: input.project_id,
      orgId: req.auth.org_id,
      repAssignments: input.rep_assignments,
      planOverrideId: input.plan_override_id ?? null,
      contractValue: String(input.contract_value),
      systemSizeKw: String(input.system_size_kw),
      updatedAt: now,
    };

    let project;
    if (existing) {
      const [updated] = await db
        .update(projectCommissionConfigs)
        .set(values)
        .where(eq(projectCommissionConfigs.id, existing.id))
        .returning();
      project = updated;

      await db.insert(auditLog).values({
        orgId: req.auth.org_id,
        actorUserId: req.auth.user_id,
        entityType: 'project_commission_config',
        entityId: existing.id,
        action: 'project_config_updated',
        before: existing,
        after: updated,
      });
    } else {
      const [created] = await db
        .insert(projectCommissionConfigs)
        .values(values)
        .returning();
      project = created;

      await db.insert(auditLog).values({
        orgId: req.auth.org_id,
        actorUserId: req.auth.user_id,
        entityType: 'project_commission_config',
        entityId: created!.id,
        action: 'project_config_created',
        before: null,
        after: created,
      });
    }

    res.status(existing ? 200 : 201).json(project);
  });

  // ── GET /api/v1/projects ────────────────────────────────────────────────────

  router.get('/', async (req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(projectCommissionConfigs)
      .where(eq(projectCommissionConfigs.orgId, req.auth.org_id))
      .orderBy(projectCommissionConfigs.updatedAt)
      .limit(100);
    res.json({ projects: rows, total: rows.length });
  });

  // ── GET /api/v1/projects/:projectId ────────────────────────────────────────

  router.get('/:projectId', async (req, res): Promise<void> => {
    const [row] = await db
      .select()
      .from(projectCommissionConfigs)
      .where(
        and(
          eq(projectCommissionConfigs.projectId, req.params['projectId']!),
          eq(projectCommissionConfigs.orgId, req.auth.org_id)
        )
      );
    if (!row) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    res.json(row);
  });

  // ── GET /api/v1/projects/:projectId/projected-commission ───────────────────

  router.get('/:projectId/projected-commission', async (req, res): Promise<void> => {
    const querySchema = z.object({ hypothetical_stage: z.string().min(1) });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }
    const { hypothetical_stage } = parsed.data;

    const [config] = await db
      .select()
      .from(projectCommissionConfigs)
      .where(
        and(
          eq(projectCommissionConfigs.projectId, req.params['projectId']!),
          eq(projectCommissionConfigs.orgId, req.auth.org_id)
        )
      );
    if (!config) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }

    // Resolve plan: override takes precedence, else active plan covering today
    const now = new Date();
    let plan: typeof commissionPlans.$inferSelect | undefined;

    if (config.planOverrideId) {
      const [p] = await db
        .select()
        .from(commissionPlans)
        .where(and(eq(commissionPlans.id, config.planOverrideId), eq(commissionPlans.orgId, req.auth.org_id)));
      plan = p;
    } else {
      const [p] = await db
        .select()
        .from(commissionPlans)
        .where(
          and(
            eq(commissionPlans.orgId, req.auth.org_id),
            eq(commissionPlans.isActive, true),
            lte(commissionPlans.effectiveFrom, now),
            or(isNull(commissionPlans.effectiveTo), gte(commissionPlans.effectiveTo, now))
          )
        )
        .limit(1);
      plan = p;
    }

    if (!plan) {
      res.json({ projections: [], reason: 'no_active_plan' });
      return;
    }

    // Only project if the hypothetical stage matches the earned trigger
    if (plan.earnedTriggerStage !== hypothetical_stage) {
      res.json({ projections: [], reason: 'stage_does_not_trigger_plan' });
      return;
    }

    // Fetch active assignments for reps listed in project config
    const repUserIds = config.repAssignments.map((r) => r.user_id);
    const activeAssignments = await db
      .select()
      .from(planAssignments)
      .where(
        and(
          eq(planAssignments.planId, plan.id),
          eq(planAssignments.orgId, req.auth.org_id),
          lte(planAssignments.effectiveFrom, now),
          or(isNull(planAssignments.effectiveTo), gte(planAssignments.effectiveTo, now))
        )
      );

    const projections: Array<{ user_id: string; amount: string; explanation: string }> = [];

    for (const rep of config.repAssignments) {
      const assignment = activeAssignments.find((a) => a.userId === rep.user_id);
      const splitPercent = assignment
        ? String(assignment.defaultSplitPercent)
        : String(rep.split_percent ?? 100);

      try {
        let amount: string;
        let explanation: string;

        if (plan.calculationType === 'percent_contract') {
          const result = calcPercentContract(plan.id, plan.rules, config.contractValue, splitPercent);
          amount = result.amount.toFixed(2);
          explanation = result.explanation;
        } else if (plan.calculationType === 'ppw') {
          const result = calcPpw(plan.id, plan.rules, config.systemSizeKw, splitPercent);
          amount = result.amount.toFixed(2);
          explanation = result.explanation;
        } else {
          continue;
        }

        if (repUserIds.includes(rep.user_id)) {
          projections.push({ user_id: rep.user_id, amount, explanation });
        }
      } catch {
        continue;
      }
    }

    res.json({ plan_id: plan.id, plan_name: plan.name, projections });
  });

  return router;
}
