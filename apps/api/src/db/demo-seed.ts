import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { orgs } from './schema/orgs';
import { users } from './schema/users';
import { commissionPlans } from './schema/plans';
import { planAssignments } from './schema/assignments';
import { projectCommissionConfigs } from './schema/projects';
import { commissionEvents } from './schema/events';
import { payoutStatements } from './schema/statements';
import { commissionAdjustments } from './schema/adjustments';
import { overrideRules } from './schema/overrides';
import { auditLog } from './schema/audit';

const log = pino({ name: 'demo-seed', level: 'info' });
const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

// ── Fixed IDs ─────────────────────────────────────────────────────────────────
const ORG      = '00000000-0000-0000-0000-000000000001';
const OLIVIA   = '00000000-0000-0000-0001-000000000001'; // admin
const RYAN     = '00000000-0000-0000-0001-000000000002'; // closer
const JORDAN   = '00000000-0000-0000-0001-000000000003'; // setter
const MARCUS   = '00000000-0000-0000-0001-000000000004'; // manager
const AISHA    = '00000000-0000-0000-0001-000000000005'; // closer
const TYLER    = '00000000-0000-0000-0001-000000000006'; // closer
const SOPHIA   = '00000000-0000-0000-0001-000000000007'; // closer

const PLAN_PCT    = '00000000-0000-0000-0002-000000000001'; // Standard Closer 3%
const PLAN_PPW    = '00000000-0000-0000-0002-000000000002'; // PPW Elite $0.40/W
const PLAN_TIER   = '00000000-0000-0000-0002-000000000003'; // Tiered Pro
const PLAN_SETTER = '00000000-0000-0000-0002-000000000004'; // Setter Bonus 0.5%

// 10 project UUIDs (simulating CRM project IDs)
const P = [
  '00000000-0000-0000-0003-000000000001', // Hernandez  – Mar, Ryan,   $42,500
  '00000000-0000-0000-0003-000000000002', // Thompson   – Mar, Aisha,  $38,750
  '00000000-0000-0000-0003-000000000003', // Williams   – Mar, Tyler,  11.5 kW
  '00000000-0000-0000-0003-000000000004', // Anderson   – Apr, Ryan,   $47,250
  '00000000-0000-0000-0003-000000000005', // Garcia     – Apr, Sophia, 12.0 kW
  '00000000-0000-0000-0003-000000000006', // Martinez   – Apr, Aisha,  $55,000
  '00000000-0000-0000-0003-000000000007', // Johnson    – May, Ryan,   $61,000
  '00000000-0000-0000-0003-000000000008', // Davis      – May, Tyler,  14.2 kW
  '00000000-0000-0000-0003-000000000009', // Wilson     – May, Sophia, disputed
  '00000000-0000-0000-0003-00000000000a', // Brown      – May, Aisha,  $29,000
] as const;

const d = (s: string) => new Date(s);
const JAN1 = d('2026-01-01');

async function main() {
  const client = postgres(DATABASE_URL!, { max: 1 });
  const db = drizzle(client);

  // ── 0. Wipe ──────────────────────────────────────────────────────────────────
  log.info('Truncating tables…');
  await db.execute(sql`
    TRUNCATE users, orgs, commission_plans, plan_assignments,
      project_commission_configs, commission_events, commission_adjustments,
      override_rules, payout_statements, audit_log RESTART IDENTITY CASCADE
  `);

  // ── 1. Org ────────────────────────────────────────────────────────────────────
  await db.insert(orgs).values({
    id: ORG, name: 'Sunscape Solar', settings: { require_event_approval: false },
  });

  // ── 2. Users ──────────────────────────────────────────────────────────────────
  await db.insert(users).values([
    { id: OLIVIA, orgId: ORG, name: 'Olivia Torres',   email: 'olivia@sunscape.solar',  role: 'admin'   },
    { id: RYAN,   orgId: ORG, name: 'Ryan Castillo',   email: 'ryan@sunscape.solar',    role: 'rep'     },
    { id: JORDAN, orgId: ORG, name: 'Jordan Bell',     email: 'jordan@sunscape.solar',  role: 'rep'     },
    { id: MARCUS, orgId: ORG, name: 'Marcus Webb',     email: 'marcus@sunscape.solar',  role: 'manager' },
    { id: AISHA,  orgId: ORG, name: 'Aisha Johnson',   email: 'aisha@sunscape.solar',   role: 'rep'     },
    { id: TYLER,  orgId: ORG, name: 'Tyler Nguyen',    email: 'tyler@sunscape.solar',   role: 'rep'     },
    { id: SOPHIA, orgId: ORG, name: 'Sophia Martinez', email: 'sophia@sunscape.solar',  role: 'rep'     },
  ]);

  // ── 3. Plans ──────────────────────────────────────────────────────────────────
  await db.insert(commissionPlans).values([
    {
      id: PLAN_PCT, orgId: ORG, name: 'Standard Closer', calculationType: 'percent_contract',
      rules: { percent: 3 }, earnedTriggerStage: 'install_complete',
      payableTrigger: { type: 'stage', value: 'install_complete' },
      clawbackConfig: { enabled: true, cancellation_stages: ['cancelled', 'lost'], clawback_percent: 100, grace_period_days: 30 },
      effectiveFrom: JAN1, effectiveTo: null, isActive: true,
    },
    {
      id: PLAN_PPW, orgId: ORG, name: 'PPW Elite', calculationType: 'ppw',
      // rate_per_watt used by CommissionPanel; dollars_per_watt used by engine
      rules: { rate_per_watt: 0.40, dollars_per_watt: 0.40 },
      earnedTriggerStage: 'permission_to_operate',
      payableTrigger: { type: 'stage', value: 'permission_to_operate' },
      clawbackConfig: null, effectiveFrom: JAN1, effectiveTo: null, isActive: true,
    },
    {
      id: PLAN_TIER, orgId: ORG, name: 'Tiered Pro', calculationType: 'tiered',
      rules: { tiers: [
        { min_kw: 0,  max_kw: 8,    rate: 0.30 },
        { min_kw: 8,  max_kw: 15,   rate: 0.35 },
        { min_kw: 15, max_kw: null,  rate: 0.40 },
      ]},
      earnedTriggerStage: 'install_complete',
      payableTrigger: { type: 'stage', value: 'install_complete' },
      clawbackConfig: { enabled: true, cancellation_stages: ['cancelled'], clawback_percent: 50, grace_period_days: 60 },
      effectiveFrom: JAN1, effectiveTo: null, isActive: true,
    },
    {
      id: PLAN_SETTER, orgId: ORG, name: 'Setter Bonus', calculationType: 'percent_contract',
      rules: { percent: 0.5 }, earnedTriggerStage: 'agreement_signed',
      payableTrigger: { type: 'stage', value: 'install_complete' },
      clawbackConfig: null, effectiveFrom: JAN1, effectiveTo: null, isActive: true,
    },
  ]);

  // ── 4. Plan Assignments ───────────────────────────────────────────────────────
  await db.insert(planAssignments).values([
    { orgId: ORG, planId: PLAN_PCT,  userId: RYAN,   role: 'closer',            defaultSplitPercent: '100.00', effectiveFrom: JAN1 },
    { orgId: ORG, planId: PLAN_PCT,  userId: AISHA,  role: 'closer',            defaultSplitPercent: '100.00', effectiveFrom: JAN1 },
    { orgId: ORG, planId: PLAN_PPW,  userId: TYLER,  role: 'closer',            defaultSplitPercent: '100.00', effectiveFrom: JAN1 },
    { orgId: ORG, planId: PLAN_TIER, userId: SOPHIA, role: 'closer',            defaultSplitPercent: '100.00', effectiveFrom: JAN1 },
    { orgId: ORG, planId: PLAN_SETTER, userId: JORDAN, role: 'setter',          defaultSplitPercent: '100.00', effectiveFrom: JAN1 },
    { orgId: ORG, planId: PLAN_PCT,  userId: MARCUS, role: 'override_recipient', defaultSplitPercent: '10.00', effectiveFrom: JAN1 },
    { orgId: ORG, planId: PLAN_PPW,  userId: MARCUS, role: 'override_recipient', defaultSplitPercent: '10.00', effectiveFrom: JAN1 },
    { orgId: ORG, planId: PLAN_TIER, userId: MARCUS, role: 'override_recipient', defaultSplitPercent: '10.00', effectiveFrom: JAN1 },
  ]);

  // ── 5. Project Configs ────────────────────────────────────────────────────────
  await db.insert(projectCommissionConfigs).values([
    // March
    { projectId: P[0], orgId: ORG, repAssignments: [{ user_id: RYAN,   role: 'closer', split_percent: 100 }, { user_id: JORDAN, role: 'setter', split_percent: 100 }], planOverrideId: null, contractValue: '42500.00', systemSizeKw: '10.20' },
    { projectId: P[1], orgId: ORG, repAssignments: [{ user_id: AISHA,  role: 'closer', split_percent: 100 }], planOverrideId: null, contractValue: '38750.00', systemSizeKw: '9.40' },
    { projectId: P[2], orgId: ORG, repAssignments: [{ user_id: TYLER,  role: 'closer', split_percent: 100 }], planOverrideId: null, contractValue: '35200.00', systemSizeKw: '11.50' },
    // April
    { projectId: P[3], orgId: ORG, repAssignments: [{ user_id: RYAN,   role: 'closer', split_percent: 100 }, { user_id: JORDAN, role: 'setter', split_percent: 100 }], planOverrideId: null, contractValue: '47250.00', systemSizeKw: '11.50' },
    { projectId: P[4], orgId: ORG, repAssignments: [{ user_id: SOPHIA, role: 'closer', split_percent: 100 }], planOverrideId: null, contractValue: '48000.00', systemSizeKw: '12.00' },
    { projectId: P[5], orgId: ORG, repAssignments: [{ user_id: AISHA,  role: 'closer', split_percent: 100 }], planOverrideId: null, contractValue: '55000.00', systemSizeKw: '13.50' },
    // May
    { projectId: P[6], orgId: ORG, repAssignments: [{ user_id: RYAN,   role: 'closer', split_percent: 100 }, { user_id: JORDAN, role: 'setter', split_percent: 100 }], planOverrideId: null, contractValue: '61000.00', systemSizeKw: '15.00' },
    { projectId: P[7], orgId: ORG, repAssignments: [{ user_id: TYLER,  role: 'closer', split_percent: 100 }], planOverrideId: null, contractValue: '53000.00', systemSizeKw: '14.20' },
    { projectId: P[8], orgId: ORG, repAssignments: [{ user_id: SOPHIA, role: 'closer', split_percent: 100 }], planOverrideId: null, contractValue: '44750.00', systemSizeKw: '10.80' },
    { projectId: P[9], orgId: ORG, repAssignments: [{ user_id: AISHA,  role: 'closer', split_percent: 100 }], planOverrideId: null, contractValue: '29000.00', systemSizeKw: '7.10'  },
  ]);

  // ── 6. Commission Events ──────────────────────────────────────────────────────
  log.info('Inserting commission events…');

  // Commission math:
  //   Standard Closer 3%: P01=$1,275 | P04=$1,417.50 | P06=$1,650 | P07=$1,830 | P10=$870
  //   PPW $0.40/W:        P03=11.5kW→$4,600 | P08=14.2kW→$5,680
  //   Tiered Pro (flat bracket): 12kW@$0.35=$4,200 | 10.8kW@$0.35=$3,780
  //   Setter Bonus 0.5%:  P01=$212.50 | P04=$236.25 | P07=$305
  //   Manager override 10% of closer earned:  see below

  const evRows = await db.insert(commissionEvents).values([
    // ── March – all paid ──────────────────────────────────────────────────────
    { orgId: ORG, projectId: P[0], userId: RYAN,   planId: PLAN_PCT,    eventType: 'earned',          amount: '1275.00', status: 'paid',     createdBy: OLIVIA, createdAt: d('2026-03-15'), triggeringStageTransitionId: 'trans-p01-install', notes: 'Install complete — Hernandez' },
    { orgId: ORG, projectId: P[0], userId: MARCUS, planId: PLAN_PCT,    eventType: 'override_earned', amount: '127.50',  status: 'paid',     createdBy: OLIVIA, createdAt: d('2026-03-15'), triggeringStageTransitionId: null,               notes: 'Override — Marcus on Hernandez' },
    { orgId: ORG, projectId: P[0], userId: JORDAN, planId: PLAN_SETTER, eventType: 'earned',          amount: '212.50',  status: 'paid',     createdBy: OLIVIA, createdAt: d('2026-03-15'), triggeringStageTransitionId: 'trans-p01-signed',  notes: 'Setter bonus — Hernandez' },

    { orgId: ORG, projectId: P[1], userId: AISHA,  planId: PLAN_PCT,    eventType: 'earned',          amount: '1162.50', status: 'paid',     createdBy: OLIVIA, createdAt: d('2026-03-22'), triggeringStageTransitionId: 'trans-p02-install', notes: 'Install complete — Thompson' },
    { orgId: ORG, projectId: P[1], userId: MARCUS, planId: PLAN_PCT,    eventType: 'override_earned', amount: '116.25',  status: 'paid',     createdBy: OLIVIA, createdAt: d('2026-03-22'), triggeringStageTransitionId: null,               notes: 'Override — Marcus on Thompson' },

    { orgId: ORG, projectId: P[2], userId: TYLER,  planId: PLAN_PPW,    eventType: 'earned',          amount: '4600.00', status: 'paid',     createdBy: OLIVIA, createdAt: d('2026-03-28'), triggeringStageTransitionId: 'trans-p03-pto',     notes: 'PTO — Williams 11.5 kW @ $0.40/W' },
    { orgId: ORG, projectId: P[2], userId: MARCUS, planId: PLAN_PPW,    eventType: 'override_earned', amount: '460.00',  status: 'paid',     createdBy: OLIVIA, createdAt: d('2026-03-28'), triggeringStageTransitionId: null,               notes: 'Override — Marcus on Williams' },

    // ── April – approved ───────────────────────────────────────────────────────
    { orgId: ORG, projectId: P[3], userId: RYAN,   planId: PLAN_PCT,    eventType: 'earned',          amount: '1417.50', status: 'approved', createdBy: OLIVIA, createdAt: d('2026-04-20'), triggeringStageTransitionId: 'trans-p04-install', notes: 'Install complete — Anderson' },
    { orgId: ORG, projectId: P[3], userId: MARCUS, planId: PLAN_PCT,    eventType: 'override_earned', amount: '141.75',  status: 'approved', createdBy: OLIVIA, createdAt: d('2026-04-20'), triggeringStageTransitionId: null,               notes: 'Override — Marcus on Anderson' },
    { orgId: ORG, projectId: P[3], userId: JORDAN, planId: PLAN_SETTER, eventType: 'earned',          amount: '236.25',  status: 'approved', createdBy: OLIVIA, createdAt: d('2026-04-20'), triggeringStageTransitionId: 'trans-p04-signed',  notes: 'Setter bonus — Anderson' },

    { orgId: ORG, projectId: P[4], userId: SOPHIA, planId: PLAN_TIER,   eventType: 'earned',          amount: '4200.00', status: 'approved', createdBy: OLIVIA, createdAt: d('2026-04-25'), triggeringStageTransitionId: 'trans-p05-install', notes: 'Install complete — Garcia 12 kW tiered @$0.35/W' },

    { orgId: ORG, projectId: P[5], userId: AISHA,  planId: PLAN_PCT,    eventType: 'earned',          amount: '1650.00', status: 'approved', createdBy: OLIVIA, createdAt: d('2026-04-28'), triggeringStageTransitionId: 'trans-p06-install', notes: 'Install complete — Martinez' },
    { orgId: ORG, projectId: P[5], userId: MARCUS, planId: PLAN_PCT,    eventType: 'override_earned', amount: '165.00',  status: 'approved', createdBy: OLIVIA, createdAt: d('2026-04-28'), triggeringStageTransitionId: null,               notes: 'Override — Marcus on Martinez' },

    // ── May – mixed statuses ───────────────────────────────────────────────────
    { orgId: ORG, projectId: P[6], userId: RYAN,   planId: PLAN_PCT,    eventType: 'earned',          amount: '1830.00', status: 'approved', createdBy: OLIVIA, createdAt: d('2026-05-10'), triggeringStageTransitionId: 'trans-p07-install', notes: 'Install complete — Johnson' },
    { orgId: ORG, projectId: P[6], userId: MARCUS, planId: PLAN_PCT,    eventType: 'override_earned', amount: '183.00',  status: 'pending',  createdBy: OLIVIA, createdAt: d('2026-05-10'), triggeringStageTransitionId: null,               notes: 'Override — Marcus on Johnson' },
    { orgId: ORG, projectId: P[6], userId: JORDAN, planId: PLAN_SETTER, eventType: 'earned',          amount: '305.00',  status: 'pending',  createdBy: OLIVIA, createdAt: d('2026-05-10'), triggeringStageTransitionId: 'trans-p07-signed',  notes: 'Setter bonus — Johnson' },

    { orgId: ORG, projectId: P[7], userId: TYLER,  planId: PLAN_PPW,    eventType: 'earned',          amount: '5680.00', status: 'pending',  createdBy: OLIVIA, createdAt: d('2026-05-16'), triggeringStageTransitionId: 'trans-p08-pto',     notes: 'PTO — Davis 14.2 kW @ $0.40/W' },
    { orgId: ORG, projectId: P[7], userId: MARCUS, planId: PLAN_PPW,    eventType: 'override_earned', amount: '568.00',  status: 'pending',  createdBy: OLIVIA, createdAt: d('2026-05-16'), triggeringStageTransitionId: null,               notes: 'Override — Marcus on Davis' },

    { orgId: ORG, projectId: P[8], userId: SOPHIA, planId: PLAN_TIER,   eventType: 'earned',          amount: '3780.00', status: 'disputed', createdBy: OLIVIA, createdAt: d('2026-05-18'), triggeringStageTransitionId: 'trans-p09-install', notes: 'Disputed: system size recorded as 10.8 kW but permit shows 9.4 kW' },

    { orgId: ORG, projectId: P[9], userId: AISHA,  planId: PLAN_PCT,    eventType: 'earned',          amount: '870.00',  status: 'pending',  createdBy: OLIVIA, createdAt: d('2026-05-20'), triggeringStageTransitionId: 'trans-p10-install', notes: 'Install complete — Brown' },
  ]).returning();

  // Index by "projectId-userId-eventType" for statement building
  const evIdx = new Map(evRows.map(e => [`${e.projectId}-${e.userId}-${e.eventType}`, e.id]));
  const ev = (pid: string, uid: string, type: string) => evIdx.get(`${pid}-${uid}-${type}`)!;

  // ── 7. Payout Statements ──────────────────────────────────────────────────────
  log.info('Inserting payout statements…');

  // March — all paid
  await db.insert(payoutStatements).values([
    {
      orgId: ORG, userId: RYAN,   periodStart: d('2026-03-01'), periodEnd: d('2026-03-31'),
      totalEarned: '1275.00', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '1275.00',
      status: 'paid', approvedBy: OLIVIA, eventIds: [ev(P[0], RYAN, 'earned')], createdAt: d('2026-04-02'),
    },
    {
      orgId: ORG, userId: AISHA,  periodStart: d('2026-03-01'), periodEnd: d('2026-03-31'),
      totalEarned: '1162.50', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '1162.50',
      status: 'paid', approvedBy: OLIVIA, eventIds: [ev(P[1], AISHA, 'earned')], createdAt: d('2026-04-02'),
    },
    {
      orgId: ORG, userId: TYLER,  periodStart: d('2026-03-01'), periodEnd: d('2026-03-31'),
      totalEarned: '4600.00', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '4600.00',
      status: 'paid', approvedBy: OLIVIA, eventIds: [ev(P[2], TYLER, 'earned')], createdAt: d('2026-04-02'),
    },
    {
      orgId: ORG, userId: MARCUS, periodStart: d('2026-03-01'), periodEnd: d('2026-03-31'),
      totalEarned: '703.75', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '703.75',
      status: 'paid', approvedBy: OLIVIA,
      eventIds: [ev(P[0], MARCUS, 'override_earned'), ev(P[1], MARCUS, 'override_earned'), ev(P[2], MARCUS, 'override_earned')],
      createdAt: d('2026-04-02'),
    },
    {
      orgId: ORG, userId: JORDAN, periodStart: d('2026-03-01'), periodEnd: d('2026-03-31'),
      totalEarned: '212.50', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '212.50',
      status: 'paid', approvedBy: OLIVIA, eventIds: [ev(P[0], JORDAN, 'earned')], createdAt: d('2026-04-02'),
    },
  ]);

  // April — approved
  await db.insert(payoutStatements).values([
    {
      orgId: ORG, userId: RYAN,   periodStart: d('2026-04-01'), periodEnd: d('2026-04-30'),
      totalEarned: '1417.50', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '1417.50',
      status: 'approved', approvedBy: OLIVIA, eventIds: [ev(P[3], RYAN, 'earned')], createdAt: d('2026-05-02'),
    },
    {
      orgId: ORG, userId: AISHA,  periodStart: d('2026-04-01'), periodEnd: d('2026-04-30'),
      totalEarned: '1650.00', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '1650.00',
      status: 'approved', approvedBy: OLIVIA, eventIds: [ev(P[5], AISHA, 'earned')], createdAt: d('2026-05-02'),
    },
    {
      orgId: ORG, userId: SOPHIA, periodStart: d('2026-04-01'), periodEnd: d('2026-04-30'),
      totalEarned: '4200.00', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '4200.00',
      status: 'approved', approvedBy: OLIVIA, eventIds: [ev(P[4], SOPHIA, 'earned')], createdAt: d('2026-05-02'),
    },
  ]);

  // May — Ryan draft
  await db.insert(payoutStatements).values({
    orgId: ORG, userId: RYAN, periodStart: d('2026-05-01'), periodEnd: d('2026-05-31'),
    totalEarned: '1830.00', totalClawedBack: '0.00', totalAdjustments: '0.00', netPayable: '1830.00',
    status: 'draft', approvedBy: null, eventIds: [ev(P[6], RYAN, 'earned')], createdAt: d('2026-05-22'),
  });

  // ── 8. Adjustments ────────────────────────────────────────────────────────────
  log.info('Inserting adjustments…');
  await db.insert(commissionAdjustments).values([
    { orgId: ORG, projectId: P[3], userId: RYAN,   amount: '500.00',  reason: 'bonus',        notes: 'Q1 top closer award — exceeded quarterly target by 18%', createdBy: OLIVIA },
    { orgId: ORG, projectId: P[2], userId: TYLER,  amount: '-200.00', reason: 'redesign',     notes: 'Panel layout redesign added 4h install labor — cost-share', createdBy: OLIVIA },
    { orgId: ORG, projectId: P[5], userId: AISHA,  amount: '350.00',  reason: 'change_order', notes: 'Customer added EV charger after contract — scope expansion', createdBy: OLIVIA },
    { orgId: ORG, projectId: P[8], userId: SOPHIA, amount: '-250.00', reason: 'penalty',      notes: 'System size overstated by 1.4 kW at time of sale',          createdBy: OLIVIA },
  ]);

  // ── 9. Override Rules ─────────────────────────────────────────────────────────
  log.info('Inserting override rules…');
  const [rule1, rule2] = await db.insert(overrideRules).values([
    {
      orgId: ORG, managerUserId: MARCUS,
      teamMemberUserIds: [RYAN, AISHA, TYLER],
      overridePercent: '10.00',
      appliesToPlanIds: [PLAN_PCT, PLAN_PPW],
      effectiveFrom: JAN1, effectiveTo: null,
    },
    {
      orgId: ORG, managerUserId: MARCUS,
      teamMemberUserIds: [RYAN, AISHA, TYLER, SOPHIA],
      overridePercent: '5.00',
      appliesToPlanIds: [PLAN_TIER],
      effectiveFrom: JAN1, effectiveTo: null,
    },
  ]).returning();

  // ── 10. Audit Log ──────────────────────────────────────────────────────────────
  log.info('Inserting audit log…');
  await db.insert(auditLog).values([
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'commission_plan',    entityId: PLAN_PCT,    action: 'plan_created',       before: null, after: { name: 'Standard Closer', percent: 3 },     createdAt: d('2026-01-03') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'commission_plan',    entityId: PLAN_PPW,    action: 'plan_created',       before: null, after: { name: 'PPW Elite', rate_per_watt: 0.40 },   createdAt: d('2026-01-03') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'commission_plan',    entityId: PLAN_TIER,   action: 'plan_created',       before: null, after: { name: 'Tiered Pro', tiers: 3 },             createdAt: d('2026-01-03') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'commission_plan',    entityId: PLAN_SETTER, action: 'plan_created',       before: null, after: { name: 'Setter Bonus', percent: 0.5 },       createdAt: d('2026-01-03') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'override_rule',      entityId: rule1!.id,   action: 'created',            before: null, after: { manager: 'Marcus Webb', team: 3, pct: 10 },  createdAt: d('2026-01-04') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'override_rule',      entityId: rule2!.id,   action: 'created',            before: null, after: { manager: 'Marcus Webb', team: 4, pct: 5 },   createdAt: d('2026-01-04') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'commission_event',   entityId: ev(P[8], SOPHIA, 'earned'), action: 'event_disputed', before: { status: 'pending' }, after: { status: 'disputed', notes: 'System size discrepancy' }, createdAt: d('2026-05-19') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'commission_plan',    entityId: PLAN_PPW,    action: 'plan_updated',       before: { dollars_per_watt: 0.35 }, after: { dollars_per_watt: 0.40 }, createdAt: d('2026-02-01') },
    { orgId: ORG, actorUserId: OLIVIA, entityType: 'plan_assignment',    entityId: PLAN_PCT,    action: 'assignment_created', before: null, after: { user: 'Aisha Johnson', plan: 'Standard Closer', role: 'closer' }, createdAt: d('2026-01-10') },
  ]);

  log.info({
    org: ORG,
    demo_token_hint: `POST /dev/token { "user_id": "${RYAN}", "org_id": "${ORG}", "role": "admin" }`,
  }, '✅ Demo seed complete');

  await client.end();
}

main().catch((err: unknown) => {
  log.error({ err }, 'Demo seed failed');
  process.exit(1);
});
