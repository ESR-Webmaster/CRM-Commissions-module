import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { count, eq } from 'drizzle-orm';
import {
  closeTestDb,
  createOrg,
  createOverrideRule,
  createPlan,
  createPlanAssignment,
  createProject,
  getTestDb,
  nullLogger,
  resetDb,
} from '../test/fixtures/engine-fixtures';
import type { Db } from '../db/index';
import { commissionEvents, orgs } from '../db/schema/index';
import { InvalidProjectConfigError } from './errors';
import { processStageTransition } from './commissionEngine';

describe('CommissionEngine', () => {
  let db: Db;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  function transition(
    orgId: string,
    projectId: string,
    toStage: string,
    opts?: Partial<{
      fromStage: string;
      transitionId: string;
      deliveryId: string;
      occurredAt: Date;
    }>
  ) {
    return {
      org_id: orgId,
      project_id: projectId,
      from_stage: opts?.fromStage ?? 'site_survey',
      to_stage: toStage,
      transition_id: opts?.transitionId ?? crypto.randomUUID(),
      delivery_id: opts?.deliveryId ?? crypto.randomUUID(),
      occurred_at: opts?.occurredAt ?? new Date(),
    };
  }

  async function eventCount(projectId: string): Promise<number> {
    const [{ value }] = await db
      .select({ value: count() })
      .from(commissionEvents)
      .where(eq(commissionEvents.projectId, projectId));
    return Number(value);
  }

  async function getEvents(projectId: string) {
    return db.select().from(commissionEvents).where(eq(commissionEvents.projectId, projectId));
  }

  // ── Test 1 ─────────────────────────────────────────────────────────────────

  it('1: single rep percent plan hits earned trigger → correct amount', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      calculationType: 'percent_contract',
      rules: { percent: 3 },
      earnedTriggerStage: 'install_complete',
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    expect(result.events_already_existed).toHaveLength(0);
    const evt = result.events_created[0]!;
    expect(evt.eventType).toBe('earned');
    expect(evt.userId).toBe(repId);
    expect(evt.amount).toBe('750.00'); // 25000 * 3%
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────

  it('2: single rep ppw plan hits earned trigger → watts × $/W', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      calculationType: 'ppw',
      rules: { dollars_per_watt: 0.15 },
      earnedTriggerStage: 'install_complete',
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '10.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    expect(result.events_created[0]!.amount).toBe('1500.00'); // 10000W × $0.15
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────

  it('3: stage not matching earned trigger produces no events', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { earnedTriggerStage: 'install_complete' });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'site_survey'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(0);
    expect(await eventCount(project.projectId)).toBe(0);
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────

  it('4: same transition_id submitted twice returns existing events, no duplicates', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });

    const input = transition(org.id, project.projectId, 'install_complete', {
      transitionId: 'idempotent-tid-4',
      deliveryId: 'idempotent-did-4',
    });

    const first = await processStageTransition(input, db, nullLogger);
    const second = await processStageTransition(input, db, nullLogger);

    expect(first.events_created).toHaveLength(1);
    expect(second.events_created).toHaveLength(0);
    expect(second.events_already_existed).toHaveLength(1);
    expect(second.events_already_existed[0]!.id).toBe(first.events_created[0]!.id);
    expect(await eventCount(project.projectId)).toBe(1);
  });

  // ── Test 5 ─────────────────────────────────────────────────────────────────

  it('5: two reps on different plans each earn at their own rate', async () => {
    const org = await createOrg(db);
    const planA = await createPlan(db, org.id, {
      name: 'Closer 3%',
      calculationType: 'percent_contract',
      rules: { percent: 3 },
    });
    const planB = await createPlan(db, org.id, {
      name: 'Setter 1%',
      calculationType: 'percent_contract',
      rules: { percent: 1 },
    });
    const closerId = crypto.randomUUID();
    const setterId = crypto.randomUUID();
    await createPlanAssignment(db, {
      orgId: org.id,
      planId: planA.id,
      userId: closerId,
      role: 'closer',
    });
    await createPlanAssignment(db, {
      orgId: org.id,
      planId: planB.id,
      userId: setterId,
      role: 'setter',
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [
        { user_id: closerId, role: 'closer', split_percent: 100 },
        { user_id: setterId, role: 'setter', split_percent: 100 },
      ],
      contractValue: '30000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(2);
    const closerEvt = result.events_created.find((e) => e.userId === closerId)!;
    const setterEvt = result.events_created.find((e) => e.userId === setterId)!;
    expect(closerEvt.amount).toBe('900.00'); // 30000 * 3%
    expect(setterEvt.amount).toBe('300.00'); // 30000 * 1%
  });

  // ── Test 6 ─────────────────────────────────────────────────────────────────

  it('6: uses plan assignment active at occurred_at, not latest', async () => {
    const org = await createOrg(db);
    const oldPlan = await createPlan(db, org.id, {
      name: 'Old 3%',
      calculationType: 'percent_contract',
      rules: { percent: 3 },
    });
    const newPlan = await createPlan(db, org.id, {
      name: 'New 5%',
      calculationType: 'percent_contract',
      rules: { percent: 5 },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, {
      orgId: org.id,
      planId: oldPlan.id,
      userId: repId,
      role: 'closer',
      effectiveFrom: new Date('2020-01-01'),
      effectiveTo: new Date('2022-12-31'),
    });
    await createPlanAssignment(db, {
      orgId: org.id,
      planId: newPlan.id,
      userId: repId,
      role: 'closer',
      effectiveFrom: new Date('2023-01-01'),
      effectiveTo: null,
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    // occurred_at is within the old plan's window
    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', {
        occurredAt: new Date('2021-06-15'),
      }),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    expect(result.events_created[0]!.planId).toBe(oldPlan.id);
    expect(result.events_created[0]!.amount).toBe('750.00'); // 25000 * 3%
  });

  // ── Test 7 ─────────────────────────────────────────────────────────────────

  it('7: override rule fires → manager gets override_earned event', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    const managerId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    await createOverrideRule(db, {
      orgId: org.id,
      managerUserId: managerId,
      teamMemberUserIds: [repId],
      overridePercent: '10.00',
      appliesToPlanIds: null,
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(2);
    const earnedEvt = result.events_created.find((e) => e.eventType === 'earned')!;
    const overrideEvt = result.events_created.find((e) => e.eventType === 'override_earned')!;
    expect(earnedEvt.amount).toBe('750.00');
    expect(overrideEvt.userId).toBe(managerId);
    expect(overrideEvt.amount).toBe('75.00'); // 10% of 750
  });

  // ── Test 8 ─────────────────────────────────────────────────────────────────

  it('8: cancellation within grace period triggers clawed_back event', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      rules: { percent: 3 },
      clawbackConfig: {
        enabled: true,
        cancellation_stages: ['cancelled'],
        clawback_percent: 100,
        grace_period_days: 30,
      },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    // Earn (createdAt ≈ now, well within 30-day grace period)
    await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { transitionId: 'earn-t8' }),
      db,
      nullLogger
    );

    const cancelResult = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', { transitionId: 'cancel-t8' }),
      db,
      nullLogger
    );

    const clawbacks = cancelResult.events_created.filter((e) => e.eventType === 'clawed_back');
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0]!.userId).toBe(repId);
    expect(clawbacks[0]!.amount).toBe('-750.00');
  });

  // ── Test 9 ─────────────────────────────────────────────────────────────────

  it('9: cancellation past grace period produces no clawback', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      rules: { percent: 3 },
      clawbackConfig: {
        enabled: true,
        cancellation_stages: ['cancelled'],
        clawback_percent: 100,
        grace_period_days: 30,
      },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    // Insert earned event backdated to 2020 (far outside grace period)
    await db.insert(commissionEvents).values({
      orgId: org.id,
      projectId: project.projectId,
      userId: repId,
      planId: plan.id,
      eventType: 'earned',
      amount: '750.00',
      triggeringStageTransitionId: 'old-earn-t9',
      deliveryId: 'old-d9',
      status: 'approved',
      notes: 'old earned event',
      createdBy: '00000000-0000-0000-0000-000000000000',
      createdAt: new Date('2020-01-01'),
    });

    // Cancel today — 1800+ days after creation, well past 30-day grace period
    const cancelResult = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', {
        transitionId: 'cancel-t9',
        occurredAt: new Date(),
      }),
      db,
      nullLogger
    );

    const clawbacks = cancelResult.events_created.filter((e) => e.eventType === 'clawed_back');
    expect(clawbacks).toHaveLength(0);
  });

  // ── Test 10 ────────────────────────────────────────────────────────────────

  it('10: plan with clawback disabled produces no clawback on cancellation', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      rules: { percent: 3 },
      clawbackConfig: null,
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });

    await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { transitionId: 'earn-t10' }),
      db,
      nullLogger
    );
    const cancelResult = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', { transitionId: 'cancel-t10' }),
      db,
      nullLogger
    );

    expect(
      cancelResult.events_created.filter((e) => e.eventType === 'clawed_back')
    ).toHaveLength(0);
  });

  // ── Test 11 ────────────────────────────────────────────────────────────────

  it('11: with two plans on a project, clawback fires only for the enabled plan', async () => {
    const org = await createOrg(db);
    const planWithCb = await createPlan(db, org.id, {
      name: 'Clawback Plan',
      rules: { percent: 3 },
      clawbackConfig: {
        enabled: true,
        cancellation_stages: ['cancelled'],
        clawback_percent: 100,
        grace_period_days: 30,
      },
    });
    const planNoCb = await createPlan(db, org.id, {
      name: 'No Clawback Plan',
      rules: { percent: 2 },
      clawbackConfig: null,
    });
    const closerId = crypto.randomUUID();
    const setterId = crypto.randomUUID();
    await createPlanAssignment(db, {
      orgId: org.id,
      planId: planWithCb.id,
      userId: closerId,
      role: 'closer',
    });
    await createPlanAssignment(db, {
      orgId: org.id,
      planId: planNoCb.id,
      userId: setterId,
      role: 'setter',
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [
        { user_id: closerId, role: 'closer', split_percent: 100 },
        { user_id: setterId, role: 'setter', split_percent: 100 },
      ],
      contractValue: '20000.00',
    });

    await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { transitionId: 'earn-t11' }),
      db,
      nullLogger
    );
    const cancelResult = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', { transitionId: 'cancel-t11' }),
      db,
      nullLogger
    );

    const clawbacks = cancelResult.events_created.filter((e) => e.eventType === 'clawed_back');
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0]!.userId).toBe(closerId);
  });

  // ── Test 12 ────────────────────────────────────────────────────────────────

  it('12: rep not in project rep_assignments does not earn even if plan-assigned', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const repA = crypto.randomUUID();
    const repB = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repA, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repB, role: 'setter' });

    // repB is NOT in the project's rep_assignments
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repA, role: 'closer', split_percent: 100 }],
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    expect(result.events_created[0]!.userId).toBe(repA);
    const events = await getEvents(project.projectId);
    expect(events.some((e) => e.userId === repB)).toBe(false);
  });

  // ── Test 13 ────────────────────────────────────────────────────────────────

  it('13: rep added to project after trigger fired does not retroactively earn', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const repA = crypto.randomUUID();
    const repB = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repA, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repB, role: 'setter' });

    // Trigger fires with only repA in rep_assignments
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repA, role: 'closer', split_percent: 100 }],
    });
    await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { transitionId: 'earn-t13' }),
      db,
      nullLogger
    );

    // repB has zero events — they weren't in rep_assignments when the trigger fired
    const events = await getEvents(project.projectId);
    expect(events.filter((e) => e.userId === repB)).toHaveLength(0);
    expect(events.filter((e) => e.userId === repA)).toHaveLength(1);
  });

  // ── Test 14 ────────────────────────────────────────────────────────────────

  it('14: zero contract_value throws InvalidProjectConfigError, no events written', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '0.00',
    });

    await expect(
      processStageTransition(
        transition(org.id, project.projectId, 'install_complete'),
        db,
        nullLogger
      )
    ).rejects.toBeInstanceOf(InvalidProjectConfigError);

    expect(await eventCount(project.projectId)).toBe(0);
  });

  // ── Test 15 ────────────────────────────────────────────────────────────────

  it('15: require_event_approval=true yields pending; false yields approved; existing untouched', async () => {
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const plan = await createPlan(db, org.id);
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });

    const project1 = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });
    const r1 = await processStageTransition(
      transition(org.id, project1.projectId, 'install_complete', { transitionId: 't15-a' }),
      db,
      nullLogger
    );
    expect(r1.events_created[0]!.status).toBe('pending');

    // Toggle org setting
    await db
      .update(orgs)
      .set({ settings: { require_event_approval: false } })
      .where(eq(orgs.id, org.id));

    const project2 = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });
    const r2 = await processStageTransition(
      transition(org.id, project2.projectId, 'install_complete', { transitionId: 't15-b' }),
      db,
      nullLogger
    );
    expect(r2.events_created[0]!.status).toBe('approved');

    // Existing event from project1 is untouched
    const [original] = await db
      .select()
      .from(commissionEvents)
      .where(eq(commissionEvents.id, r1.events_created[0]!.id))
      .limit(1);
    expect(original!.status).toBe('pending');
  });

  // ── Test 16 ────────────────────────────────────────────────────────────────

  it('16: money math is precise for fractional percent and split', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      calculationType: 'percent_contract',
      rules: { percent: 3.33 },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, {
      orgId: org.id,
      planId: plan.id,
      userId: repId,
      role: 'closer',
      splitPercent: '33.33',
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 33.33 }],
      contractValue: '12345.67',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    const expected = new Decimal('12345.67')
      .mul('3.33')
      .div(100)
      .mul('33.33')
      .div(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
      .toFixed(2);
    expect(result.events_created[0]!.amount).toBe(expected);
  });

  // ── Test 17 ────────────────────────────────────────────────────────────────

  it('17: concurrent calls with same transition_id produce exactly one event', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });

    const input = transition(org.id, project.projectId, 'install_complete', {
      transitionId: 'concurrent-tid-17',
      deliveryId: 'concurrent-did-17',
    });

    const [r1, r2] = await Promise.all([
      processStageTransition(input, db, nullLogger),
      processStageTransition(input, db, nullLogger),
    ]);

    expect(await eventCount(project.projectId)).toBe(1);

    const id1 = [...r1.events_created, ...r1.events_already_existed][0]!.id;
    const id2 = [...r2.events_created, ...r2.events_already_existed][0]!.id;
    expect(id1).toBe(id2);
  });

  // ── Golden suite additions (Tests 18-50) ───────────────────────────────────
  // Hand-calculated amounts for every scenario below. Wrong number = revert.

  const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

  // ── percent_contract edge cases ───────────────────────────────────────────

  it('18: negative contract_value throws InvalidProjectConfigError, no events', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '-100.00',
    });

    await expect(
      processStageTransition(transition(org.id, project.projectId, 'install_complete'), db, nullLogger)
    ).rejects.toBeInstanceOf(InvalidProjectConfigError);

    expect(await eventCount(project.projectId)).toBe(0);
  });

  it('19: percent = 0 → earned event written with amount = $0.00', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 0 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    // Zero commission is still a valid event — records that we considered it
    expect(result.events_created).toHaveLength(1);
    expect(result.events_created[0]!.amount).toBe('0.00');
  });

  it('20: split_percent = 50 → half of plan commission', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 50 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    // 25000 × 3% = 750, × 50% = 375.00
    expect(result.events_created[0]!.amount).toBe('375.00');
  });

  it('21: split_percent = 33.33 → banker\'s rounding applied at final step', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 33.33 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    // 25000 × 3% = 750; 750 × 33.33% = 249.975
    // ROUND_HALF_EVEN: 7 is odd → round up → 249.98
    const expected = new Decimal('25000').mul('3').div(100).mul('33.33').div(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
    expect(expected).toBe('249.98'); // sanity-check the fixture math
    expect(result.events_created[0]!.amount).toBe(expected);
  });

  it('22: very large contract ($999,999.99) × 5% → no numeric overflow', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 5 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '999999.99',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    // 999999.99 × 5% = 49999.9995 → ROUND_HALF_EVEN → 50000.00
    const expected = new Decimal('999999.99').mul('5').div(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
    expect(expected).toBe('50000.00');
    expect(result.events_created[0]!.amount).toBe(expected);
  });

  it('23: very small percent (0.01%) on $10,000 → $1.00 exactly', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 0.01 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '10000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    // 10000 × 0.01% = 10000 × 0.0001 = 1.00
    expect(result.events_created[0]!.amount).toBe('1.00');
  });

  it('24: two reps, split_percents sum to 100 → amounts sum to full commission', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const closerId = crypto.randomUUID();
    const setterId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: closerId, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: setterId, role: 'setter' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [
        { user_id: closerId, role: 'closer', split_percent: 60 },
        { user_id: setterId, role: 'setter', split_percent: 40 },
      ],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    expect(result.events_created).toHaveLength(2);
    const closerAmt = result.events_created.find((e) => e.userId === closerId)!.amount;
    const setterAmt = result.events_created.find((e) => e.userId === setterId)!.amount;
    // closer: 25000 × 3% × 60% = 450.00; setter: 25000 × 3% × 40% = 300.00; sum = 750.00
    expect(closerAmt).toBe('450.00');
    expect(setterAmt).toBe('300.00');
    expect(
      new Decimal(closerAmt).add(setterAmt).toFixed(2)
    ).toBe('750.00'); // sum equals full gross commission
  });

  it('25: two reps, split_percents sum to < 100 → each gets individual split (remainder not distributed)', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const closerId = crypto.randomUUID();
    const setterId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: closerId, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: setterId, role: 'setter' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [
        { user_id: closerId, role: 'closer', split_percent: 60 },
        { user_id: setterId, role: 'setter', split_percent: 20 }, // total 80%, 20% unrealised
      ],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db,
      nullLogger
    );

    const closerAmt = result.events_created.find((e) => e.userId === closerId)!.amount;
    const setterAmt = result.events_created.find((e) => e.userId === setterId)!.amount;
    // closer: 750 × 60% = 450.00; setter: 750 × 20% = 150.00
    expect(closerAmt).toBe('450.00');
    expect(setterAmt).toBe('150.00');
    // total 600 ≠ 750 — remainder is NOT redistributed
    expect(new Decimal(closerAmt).add(setterAmt).toFixed(2)).toBe('600.00');
  });

  it('26: clawback_percent = 50 → partial clawback at half the original amount', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      rules: { percent: 3 },
      clawbackConfig: { enabled: true, cancellation_stages: ['cancelled'], clawback_percent: 50, grace_period_days: 30 },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { transitionId: 'earn-t26' }),
      db, nullLogger
    );
    const result = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', { transitionId: 'cancel-t26' }),
      db, nullLogger
    );

    // earned = 750.00; clawback = -(750 × 50%) = -375.00
    const cb = result.events_created.find((e) => e.eventType === 'clawed_back')!;
    expect(cb.amount).toBe('-375.00');
  });

  it('27: grace period boundary (exactly N days ago) → clawback fires (boundary inclusive)', async () => {
    const graceDays = 30;
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      rules: { percent: 3 },
      clawbackConfig: { enabled: true, cancellation_stages: ['cancelled'], clawback_percent: 100, grace_period_days: graceDays },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    // Insert earned event at exactly graceDays before the cancel transition
    const cancelDate = new Date('2026-02-01T00:00:00Z');
    const earnDate = new Date('2026-01-02T00:00:00Z'); // exactly 30 days before Feb 1
    await db.insert(commissionEvents).values({
      orgId: org.id,
      projectId: project.projectId,
      userId: repId,
      planId: plan.id,
      eventType: 'earned',
      amount: '750.00',
      triggeringStageTransitionId: 'earn-t27',
      deliveryId: 'd27-earn',
      status: 'approved',
      notes: 'boundary earn',
      createdBy: SYSTEM_ACTOR,
      createdAt: earnDate,
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', { transitionId: 'cancel-t27', occurredAt: cancelDate }),
      db, nullLogger
    );

    // ageDays = (Feb 1 - Jan 2) / ms_per_day = 30.0; 30 <= 30 → fires
    const cb = result.events_created.find((e) => e.eventType === 'clawed_back');
    expect(cb).toBeDefined();
    expect(cb!.amount).toBe('-750.00');
  });

  // ── ppw edge cases ────────────────────────────────────────────────────────

  it('28: system_size_kw = 0 → InvalidProjectConfigError, no events', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.15 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '0.00',
    });

    await expect(
      processStageTransition(transition(org.id, project.projectId, 'install_complete'), db, nullLogger)
    ).rejects.toBeInstanceOf(InvalidProjectConfigError);

    expect(await eventCount(project.projectId)).toBe(0);
  });

  it('29: negative system_size_kw → InvalidProjectConfigError, no events', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.15 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '-5.00',
    });

    await expect(
      processStageTransition(transition(org.id, project.projectId, 'install_complete'), db, nullLogger)
    ).rejects.toBeInstanceOf(InvalidProjectConfigError);

    expect(await eventCount(project.projectId)).toBe(0);
  });

  it('30: ppw exact calculation — 7.5kW × $0.15/W × 100% split', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.15 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '7.50',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    // 7500W × $0.15/W = $1125.00
    expect(result.events_created[0]!.amount).toBe('1125.00');
  });

  it('31: ppw with high-precision parameters — decimal precision preserved to the cent', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.1234 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '6.79',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    // 6790W × $0.1234/W = 837.886 → ROUND_HALF_EVEN → 837.89
    const expected = new Decimal('6790').mul('0.1234')
      .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
    expect(expected).toBe('837.89');
    expect(result.events_created[0]!.amount).toBe(expected);
  });

  it('32: ppw plan with split_percent = 75 → split applied after watts × rate', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.15 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 75 }],
      systemSizeKw: '10.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    // 10000W × $0.15/W = $1500 × 75% = $1125.00
    expect(result.events_created[0]!.amount).toBe('1125.00');
  });

  it('33: two reps on ppw plan (closer 60%, setter 40%) → two events', async () => {
    const org = await createOrg(db);
    const planCloser = await createPlan(db, org.id, {
      name: 'PPW Closer',
      calculationType: 'ppw',
      rules: { dollars_per_watt: 0.15 },
    });
    const planSetter = await createPlan(db, org.id, {
      name: 'PPW Setter',
      calculationType: 'ppw',
      rules: { dollars_per_watt: 0.15 },
    });
    const closerId = crypto.randomUUID();
    const setterId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: planCloser.id, userId: closerId, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: planSetter.id, userId: setterId, role: 'setter' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [
        { user_id: closerId, role: 'closer', split_percent: 60 },
        { user_id: setterId, role: 'setter', split_percent: 40 },
      ],
      systemSizeKw: '10.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    expect(result.events_created).toHaveLength(2);
    // closer: 10000W × $0.15 × 60% = $900.00; setter: 10000W × $0.15 × 40% = $600.00
    expect(result.events_created.find((e) => e.userId === closerId)!.amount).toBe('900.00');
    expect(result.events_created.find((e) => e.userId === setterId)!.amount).toBe('600.00');
  });

  it('34: very large ppw system (100kW × $0.50/W) → $50,000 with no overflow', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.5 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '100.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    // 100000W × $0.50/W = $50,000.00
    expect(result.events_created[0]!.amount).toBe('50000.00');
  });

  it('35: ppw plan clawback on exact grace period boundary → fires', async () => {
    const graceDays = 30;
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, {
      calculationType: 'ppw',
      rules: { dollars_per_watt: 0.15 },
      clawbackConfig: { enabled: true, cancellation_stages: ['cancelled'], clawback_percent: 100, grace_period_days: graceDays },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '10.00',
    });

    const cancelDate = new Date('2026-03-01T00:00:00Z');
    const earnDate = new Date('2026-01-30T00:00:00Z'); // exactly 30 days before March 1

    await db.insert(commissionEvents).values({
      orgId: org.id,
      projectId: project.projectId,
      userId: repId,
      planId: plan.id,
      eventType: 'earned',
      amount: '1500.00',
      triggeringStageTransitionId: 'earn-t35',
      deliveryId: 'd35-earn',
      status: 'approved',
      notes: 'ppw boundary earn',
      createdBy: SYSTEM_ACTOR,
      createdAt: earnDate,
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', { transitionId: 'cancel-t35', occurredAt: cancelDate }),
      db, nullLogger
    );

    const cb = result.events_created.find((e) => e.eventType === 'clawed_back');
    expect(cb).toBeDefined();
    // 10000W × $0.15/W = $1500 earned; 100% clawback = -$1500.00
    expect(cb!.amount).toBe('-1500.00');
  });

  // ── Plan version resolution ───────────────────────────────────────────────

  it('36: plan replaced mid-pipeline → event uses plan active at occurred_at', async () => {
    const org = await createOrg(db);
    const planA = await createPlan(db, org.id, {
      name: 'Plan A (3%)',
      rules: { percent: 3 },
      effectiveFrom: new Date('2020-01-01'),
      effectiveTo: new Date('2022-12-31'),
    });
    const planB = await createPlan(db, org.id, {
      name: 'Plan B (5%)',
      rules: { percent: 5 },
      effectiveFrom: new Date('2023-01-01'),
      effectiveTo: null,
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, {
      orgId: org.id, planId: planA.id, userId: repId, role: 'closer',
      effectiveFrom: new Date('2020-01-01'), effectiveTo: new Date('2022-12-31'),
    });
    await createPlanAssignment(db, {
      orgId: org.id, planId: planB.id, userId: repId, role: 'closer',
      effectiveFrom: new Date('2023-01-01'), effectiveTo: null,
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    // Transition fires in 2024 — within plan B's window
    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { occurredAt: new Date('2024-06-15') }),
      db, nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    expect(result.events_created[0]!.planId).toBe(planB.id);
    // Plan B: 25000 × 5% = 1250.00
    expect(result.events_created[0]!.amount).toBe('1250.00');
  });

  it('37: plan assignment not yet effective at occurred_at → no plan resolves → 0 events', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, {
      orgId: org.id, planId: plan.id, userId: repId, role: 'closer',
      effectiveFrom: new Date('2030-01-01'), // future — not effective yet
      effectiveTo: null,
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { occurredAt: new Date() }),
      db, nullLogger
    );

    expect(result.events_created).toHaveLength(0);
    expect(await eventCount(project.projectId)).toBe(0);
  });

  it('38: plan assignment expired before occurred_at → no plan resolves → 0 events', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, {
      orgId: org.id, planId: plan.id, userId: repId, role: 'closer',
      effectiveFrom: new Date('2020-01-01'),
      effectiveTo: new Date('2020-12-31'), // expired in 2020
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { occurredAt: new Date() }),
      db, nullLogger
    );

    expect(result.events_created).toHaveLength(0);
    expect(await eventCount(project.projectId)).toBe(0);
  });

  it('39: rep with two roles on different plans, different trigger stages → two earned events across two transitions', async () => {
    const org = await createOrg(db);
    const planA = await createPlan(db, org.id, { name: 'Closer Plan', rules: { percent: 3 }, earnedTriggerStage: 'install_complete' });
    const planB = await createPlan(db, org.id, { name: 'Setter Plan', rules: { percent: 1 }, earnedTriggerStage: 'permit_received' });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: planA.id, userId: repId, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: planB.id, userId: repId, role: 'setter' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [
        { user_id: repId, role: 'closer', split_percent: 100 },
        { user_id: repId, role: 'setter', split_percent: 100 },
      ],
      contractValue: '25000.00',
    });

    const r1 = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { transitionId: 't39-install' }),
      db, nullLogger
    );
    const r2 = await processStageTransition(
      transition(org.id, project.projectId, 'permit_received', { transitionId: 't39-permit' }),
      db, nullLogger
    );

    // Each transition earns from the matching plan only
    expect(r1.events_created).toHaveLength(1);
    expect(r1.events_created[0]!.planId).toBe(planA.id);
    expect(r1.events_created[0]!.amount).toBe('750.00'); // 25000 × 3%
    expect(r2.events_created).toHaveLength(1);
    expect(r2.events_created[0]!.planId).toBe(planB.id);
    expect(r2.events_created[0]!.amount).toBe('250.00'); // 25000 × 1%
  });

  it('40: project planOverrideId takes precedence over rep\'s default plan assignment', async () => {
    const org = await createOrg(db);
    const assignedPlan = await createPlan(db, org.id, { name: 'Assigned (3%)', rules: { percent: 3 } });
    const overridePlan = await createPlan(db, org.id, { name: 'Override (5%)', rules: { percent: 5 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: assignedPlan.id, userId: repId, role: 'closer' });
    // Project configured with a plan override — should win over the rep's assignment
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      planOverrideId: overridePlan.id,
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    expect(result.events_created[0]!.planId).toBe(overridePlan.id); // override wins
    // 25000 × 5% = 1250.00 (not 750.00 from assigned plan)
    expect(result.events_created[0]!.amount).toBe('1250.00');
  });

  // ── Multi-rep and override ────────────────────────────────────────────────

  it('41: specific applies_to_plan_ids → override fires only for that plan', async () => {
    const org = await createOrg(db);
    const planA = await createPlan(db, org.id, { name: 'Plan A', rules: { percent: 3 } });
    const planB = await createPlan(db, org.id, { name: 'Plan B', rules: { percent: 3 }, earnedTriggerStage: 'permit_received' });
    const repA = crypto.randomUUID();
    const repB = crypto.randomUUID();
    const managerId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: planA.id, userId: repA, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: planB.id, userId: repB, role: 'setter' });
    // Override applies to planA only
    await createOverrideRule(db, {
      orgId: org.id,
      managerUserId: managerId,
      teamMemberUserIds: [repA, repB],
      overridePercent: '10.00',
      appliesToPlanIds: [planA.id], // specific to plan A
    });

    const projectA = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repA, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });
    const projectB = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repB, role: 'setter', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const rA = await processStageTransition(
      transition(org.id, projectA.projectId, 'install_complete', { transitionId: 't41-a' }),
      db, nullLogger
    );
    const rB = await processStageTransition(
      transition(org.id, projectB.projectId, 'permit_received', { transitionId: 't41-b' }),
      db, nullLogger
    );

    // rep A (plan A): earned + override_earned
    expect(rA.events_created.some((e) => e.eventType === 'override_earned')).toBe(true);
    // rep B (plan B): earned only — override does NOT fire for plan B
    expect(rB.events_created.some((e) => e.eventType === 'override_earned')).toBe(false);
    expect(rA.events_created.find((e) => e.eventType === 'override_earned')!.amount)
      .toBe('75.00'); // 10% of 750
  });

  it('42: applies_to_plan_ids = null → override fires for all plans (v1: null = all plans)', async () => {
    const org = await createOrg(db);
    // Use PPW plan to distinguish from Test 7
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.20 } });
    const repId = crypto.randomUUID();
    const managerId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    await createOverrideRule(db, {
      orgId: org.id,
      managerUserId: managerId,
      teamMemberUserIds: [repId],
      overridePercent: '10.00',
      appliesToPlanIds: null, // null = applies to all plans
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '5.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    // 5000W × $0.20 = $1000 earned; override 10% = $100.00
    expect(result.events_created.find((e) => e.eventType === 'earned')!.amount).toBe('1000.00');
    expect(result.events_created.find((e) => e.eventType === 'override_earned')!.amount).toBe('100.00');
  });

  it('43: two override rules for same manager — specific plan rule beats general (null) rule', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    const managerId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    // General rule (all plans, 10%)
    await createOverrideRule(db, {
      orgId: org.id, managerUserId: managerId, teamMemberUserIds: [repId],
      overridePercent: '10.00', appliesToPlanIds: null,
    });
    // Specific rule (this plan, 15%) — should win
    await createOverrideRule(db, {
      orgId: org.id, managerUserId: managerId, teamMemberUserIds: [repId],
      overridePercent: '15.00', appliesToPlanIds: [plan.id],
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    // One override event; amount from the specific rule: 15% of 750 = 112.50
    const overrideEvents = result.events_created.filter((e) => e.eventType === 'override_earned');
    expect(overrideEvents).toHaveLength(1);
    expect(overrideEvents[0]!.amount).toBe('112.50');
  });

  it('44: two specific override rules for same manager + plan → exactly one override event fired', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    const managerId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    await createOverrideRule(db, {
      orgId: org.id, managerUserId: managerId, teamMemberUserIds: [repId],
      overridePercent: '10.00', appliesToPlanIds: [plan.id],
    });
    await createOverrideRule(db, {
      orgId: org.id, managerUserId: managerId, teamMemberUserIds: [repId],
      overridePercent: '10.00', appliesToPlanIds: [plan.id],
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    // Only one override event created despite two matching rules (de-duped by manager)
    const overrideEvents = result.events_created.filter((e) => e.eventType === 'override_earned');
    expect(overrideEvents).toHaveLength(1);
    expect(overrideEvents[0]!.amount).toBe('75.00'); // 10% of 750
  });

  it('45: team_member_user_ids = [] → override rule matches no rep → no override event', async () => {
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    const managerId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    await createOverrideRule(db, {
      orgId: org.id,
      managerUserId: managerId,
      teamMemberUserIds: [], // empty — no reps belong to this manager
      overridePercent: '10.00',
      appliesToPlanIds: null,
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    expect(result.events_created).toHaveLength(1);
    expect(result.events_created[0]!.eventType).toBe('earned');
    // No override_earned — empty team array matches no rep
    expect(result.events_created.some((e) => e.eventType === 'override_earned')).toBe(false);
  });

  // ── Status and approval ───────────────────────────────────────────────────

  it('46: require_event_approval = true → earned event status = pending (PPW plan)', async () => {
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const plan = await createPlan(db, org.id, { calculationType: 'ppw', rules: { dollars_per_watt: 0.15 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      systemSizeKw: '10.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    expect(result.events_created[0]!.status).toBe('pending');
  });

  it('47: require_event_approval = false → all earned events status = approved (two reps)', async () => {
    const org = await createOrg(db, { settings: { require_event_approval: false } });
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const closerId = crypto.randomUUID();
    const setterId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: closerId, role: 'closer' });
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: setterId, role: 'setter' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [
        { user_id: closerId, role: 'closer', split_percent: 60 },
        { user_id: setterId, role: 'setter', split_percent: 40 },
      ],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    expect(result.events_created).toHaveLength(2);
    result.events_created.forEach((e) => expect(e.status).toBe('approved'));
  });

  it('48: toggle require_event_approval true→false; pre-existing pending events stay pending', async () => {
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const plan = await createPlan(db, org.id);
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });

    const project1 = await createProject(db, {
      orgId: org.id, repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });
    const r1 = await processStageTransition(
      transition(org.id, project1.projectId, 'install_complete', { transitionId: 't48-before' }),
      db, nullLogger
    );
    expect(r1.events_created[0]!.status).toBe('pending');

    // Toggle off
    await db.update(orgs).set({ settings: { require_event_approval: false } }).where(eq(orgs.id, org.id));

    const project2 = await createProject(db, {
      orgId: org.id, repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });
    const r2 = await processStageTransition(
      transition(org.id, project2.projectId, 'install_complete', { transitionId: 't48-after' }),
      db, nullLogger
    );
    expect(r2.events_created[0]!.status).toBe('approved');

    // The original event is still pending — toggle is NOT retroactive
    const [original] = await db.select().from(commissionEvents)
      .where(eq(commissionEvents.id, r1.events_created[0]!.id)).limit(1);
    expect(original!.status).toBe('pending');
  });

  it('49: require_event_approval = true → clawed_back event status = pending', async () => {
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const plan = await createPlan(db, org.id, {
      rules: { percent: 3 },
      clawbackConfig: { enabled: true, cancellation_stages: ['cancelled'], clawback_percent: 100, grace_period_days: 30 },
    });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    await processStageTransition(
      transition(org.id, project.projectId, 'install_complete', { transitionId: 'earn-t49' }),
      db, nullLogger
    );
    const result = await processStageTransition(
      transition(org.id, project.projectId, 'cancelled', { transitionId: 'cancel-t49' }),
      db, nullLogger
    );

    const cb = result.events_created.find((e) => e.eventType === 'clawed_back');
    expect(cb).toBeDefined();
    // clawed_back inherits the org's require_event_approval setting
    expect(cb!.status).toBe('pending');
  });

  it('50: require_event_approval = true → override_earned event status = pending', async () => {
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const plan = await createPlan(db, org.id, { rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    const managerId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });
    await createOverrideRule(db, {
      orgId: org.id,
      managerUserId: managerId,
      teamMemberUserIds: [repId],
      overridePercent: '10.00',
      appliesToPlanIds: null,
    });
    const project = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
      contractValue: '25000.00',
    });

    const result = await processStageTransition(
      transition(org.id, project.projectId, 'install_complete'),
      db, nullLogger
    );

    const override = result.events_created.find((e) => e.eventType === 'override_earned');
    expect(override).toBeDefined();
    // override_earned inherits the org's require_event_approval setting
    expect(override!.status).toBe('pending');
  });
});
