import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { orgs } from './schema/orgs';
import { commissionPlans } from './schema/plans';
import { planAssignments } from './schema/assignments';
import { projectCommissionConfigs } from './schema/projects';
import { sql } from 'drizzle-orm';
import pino from 'pino';

const logger = pino({ name: 'seed' });

const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error('DATABASE_URL environment variable is required');
}

const isReset = process.argv.includes('--reset');

// Fixed UUIDs for idempotency
const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ADMIN = '00000000-0000-0000-0001-000000000001';
const USER_CLOSER = '00000000-0000-0000-0001-000000000002';
const USER_SETTER = '00000000-0000-0000-0001-000000000003';
const PLAN_PERCENT = '00000000-0000-0000-0002-000000000001';
const PLAN_PPW = '00000000-0000-0000-0002-000000000002';

const PROJECT_IDS = [
  '00000000-0000-0000-0003-000000000001',
  '00000000-0000-0000-0003-000000000002',
  '00000000-0000-0000-0003-000000000003',
  '00000000-0000-0000-0003-000000000004',
  '00000000-0000-0000-0003-000000000005',
];

async function main() {
  const client = postgres(url as string, { max: 1 });
  const db = drizzle(client);

  if (isReset) {
    logger.info('Resetting database...');
    await db.execute(sql`TRUNCATE orgs, commission_plans, plan_assignments,
      project_commission_configs, commission_events, commission_adjustments,
      override_rules, payout_statements, audit_log RESTART IDENTITY CASCADE`);
  }

  logger.info('Seeding orgs...');
  await db
    .insert(orgs)
    .values({
      id: ORG_ID,
      name: 'Sunscape Solar',
      settings: { require_event_approval: false },
    })
    .onConflictDoNothing();

  logger.info('Seeding commission plans...');
  const now = new Date();
  const laterStart = new Date('2026-06-01');

  await db
    .insert(commissionPlans)
    .values([
      {
        id: PLAN_PERCENT,
        orgId: ORG_ID,
        name: 'Standard % Contract',
        calculationType: 'percent_contract',
        rules: { percent: 3 },
        earnedTriggerStage: 'install_complete',
        payableTrigger: { type: 'stage', value: 'install_complete' },
        clawbackConfig: {
          enabled: true,
          cancellation_stages: ['cancelled', 'lost'],
          clawback_percent: 100,
          grace_period_days: 30,
        },
        effectiveFrom: now,
        effectiveTo: null,
        isActive: true,
      },
      {
        id: PLAN_PPW,
        orgId: ORG_ID,
        name: 'PPW Rate Plan',
        calculationType: 'ppw',
        rules: { dollars_per_watt: 0.15 },
        earnedTriggerStage: 'install_complete',
        payableTrigger: { type: 'stage', value: 'install_complete' },
        clawbackConfig: null,
        effectiveFrom: now,
        effectiveTo: null,
        isActive: true,
      },
    ])
    .onConflictDoNothing();

  logger.info('Seeding plan assignments...');
  await db
    .insert(planAssignments)
    .values([
      {
        orgId: ORG_ID,
        planId: PLAN_PERCENT,
        userId: USER_CLOSER,
        role: 'closer',
        defaultSplitPercent: '100.00',
        effectiveFrom: now,
        effectiveTo: null,
      },
      {
        orgId: ORG_ID,
        planId: PLAN_PERCENT,
        userId: USER_SETTER,
        role: 'setter',
        defaultSplitPercent: '100.00',
        effectiveFrom: now,
        effectiveTo: null,
      },
      {
        orgId: ORG_ID,
        planId: PLAN_PPW,
        userId: USER_CLOSER,
        role: 'closer',
        defaultSplitPercent: '100.00',
        effectiveFrom: laterStart,
        effectiveTo: null,
      },
    ])
    .onConflictDoNothing();

  logger.info('Seeding project commission configs...');
  const projectValues = PROJECT_IDS.map((projectId, i) => ({
    projectId,
    orgId: ORG_ID,
    repAssignments: [{ user_id: USER_CLOSER, role: 'closer' as const, split_percent: 100 }],
    planOverrideId: null,
    contractValue: String((25000 + i * 5000).toFixed(2)),
    systemSizeKw: String((8 + i * 2).toFixed(2)),
  }));
  await db.insert(projectCommissionConfigs).values(projectValues).onConflictDoNothing();

  logger.info(
    `Seed complete.\n  Org: ${ORG_ID}\n  Users: admin=${USER_ADMIN}, closer=${USER_CLOSER}, setter=${USER_SETTER}\n  Plans: percent=${PLAN_PERCENT}, ppw=${PLAN_PPW}\n  Projects: ${PROJECT_IDS.length}`
  );
  await client.end();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Seed failed');
  process.exit(1);
});
