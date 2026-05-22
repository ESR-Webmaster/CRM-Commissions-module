import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import * as schema from '../../db/schema/index';
import type { Db } from '../../db/index';
import type { ClawbackConfig, CommissionRules, PayableTrigger } from '../../db/schema/plans';
import type { RepAssignment } from '../../db/schema/projects';
import type { OrgSettings } from '../../db/schema/orgs';

// ── Connection ────────────────────────────────────────────────────────────────

const TEST_DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://commissions:commissions@localhost:5433/commissions';

let _client: ReturnType<typeof postgres> | null = null;
let _db: Db | null = null;

export function getTestDb(): Db {
  if (!_db) {
    _client = postgres(TEST_DB_URL, { max: 5 });
    _db = drizzle(_client, { schema });
  }
  return _db;
}

export async function closeTestDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export async function resetDb(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE users, orgs, commission_plans, plan_assignments,
      project_commission_configs, commission_events, commission_adjustments,
      override_rules, payout_statements, audit_log RESTART IDENTITY CASCADE`
  );
}

export async function createUser(
  db: Db,
  orgId: string,
  overrides?: Partial<{ id: string; name: string; email: string; role: string }>
) {
  const [row] = await db
    .insert(schema.users)
    .values({
      id: overrides?.id ?? crypto.randomUUID(),
      orgId,
      name: overrides?.name ?? 'Test User',
      email: overrides?.email ?? `user-${crypto.randomUUID()}@test.com`,
      role: overrides?.role ?? 'rep',
    })
    .returning();
  return row!;
}

// ── Factories ────────────────────────────────────────────────────────────────

export async function createOrg(
  db: Db,
  overrides?: Partial<{ id: string; name: string; settings: OrgSettings }>
) {
  const [row] = await db
    .insert(schema.orgs)
    .values({
      id: overrides?.id ?? crypto.randomUUID(),
      name: overrides?.name ?? 'Test Org',
      settings: overrides?.settings ?? { require_event_approval: false },
    })
    .returning();
  return row!;
}

export async function createPlan(
  db: Db,
  orgId: string,
  overrides?: Partial<{
    id: string;
    name: string;
    calculationType: 'percent_contract' | 'ppw' | 'tiered' | 'hybrid';
    rules: CommissionRules;
    earnedTriggerStage: string;
    payableTrigger: PayableTrigger;
    clawbackConfig: ClawbackConfig | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    isActive: boolean;
  }>
) {
  const [row] = await db
    .insert(schema.commissionPlans)
    .values({
      id: overrides?.id ?? crypto.randomUUID(),
      orgId,
      name: overrides?.name ?? 'Test Plan',
      calculationType: overrides?.calculationType ?? 'percent_contract',
      rules: overrides?.rules ?? { percent: 3 },
      earnedTriggerStage: overrides?.earnedTriggerStage ?? 'install_complete',
      payableTrigger: overrides?.payableTrigger ?? { type: 'stage', value: 'install_complete' },
      clawbackConfig: overrides?.clawbackConfig !== undefined ? overrides.clawbackConfig : null,
      effectiveFrom: overrides?.effectiveFrom ?? new Date('2020-01-01'),
      effectiveTo: overrides?.effectiveTo ?? null,
      isActive: overrides?.isActive ?? true,
    })
    .returning();
  return row!;
}

export async function createPlanAssignment(
  db: Db,
  {
    orgId,
    planId,
    userId,
    role,
    effectiveFrom,
    effectiveTo,
    splitPercent,
  }: {
    orgId: string;
    planId: string;
    userId: string;
    role: 'closer' | 'setter' | 'manager' | 'override_recipient';
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    splitPercent?: string;
  }
) {
  const [row] = await db
    .insert(schema.planAssignments)
    .values({
      orgId,
      planId,
      userId,
      role,
      defaultSplitPercent: splitPercent ?? '100.00',
      effectiveFrom: effectiveFrom ?? new Date('2020-01-01'),
      effectiveTo: effectiveTo ?? null,
    })
    .returning();
  return row!;
}

export async function createProject(
  db: Db,
  {
    orgId,
    projectId,
    repAssignments,
    planOverrideId,
    contractValue,
    systemSizeKw,
  }: {
    orgId: string;
    projectId?: string;
    repAssignments: RepAssignment[];
    planOverrideId?: string | null;
    contractValue?: string;
    systemSizeKw?: string;
  }
) {
  const [row] = await db
    .insert(schema.projectCommissionConfigs)
    .values({
      projectId: projectId ?? crypto.randomUUID(),
      orgId,
      repAssignments,
      planOverrideId: planOverrideId ?? null,
      contractValue: contractValue ?? '25000.00',
      systemSizeKw: systemSizeKw ?? '10.00',
    })
    .returning();
  return row!;
}

export async function createOverrideRule(
  db: Db,
  {
    orgId,
    managerUserId,
    teamMemberUserIds,
    overridePercent,
    appliesToPlanIds,
    effectiveFrom,
    effectiveTo,
  }: {
    orgId: string;
    managerUserId: string;
    teamMemberUserIds: string[];
    overridePercent: string;
    appliesToPlanIds?: string[] | null;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
  }
) {
  const [row] = await db
    .insert(schema.overrideRules)
    .values({
      orgId,
      managerUserId,
      teamMemberUserIds,
      overridePercent,
      appliesToPlanIds: appliesToPlanIds ?? null,
      effectiveFrom: effectiveFrom ?? new Date('2020-01-01'),
      effectiveTo: effectiveTo ?? null,
    })
    .returning();
  return row!;
}

// ── Null logger (suppresses engine output during tests unless DEBUG=1) ────────

export const nullLogger = {
  debug: process.env['DEBUG'] ? console.debug.bind(console) : () => undefined,
  info: process.env['DEBUG'] ? console.info.bind(console) : () => undefined,
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
