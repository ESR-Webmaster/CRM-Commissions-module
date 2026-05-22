// Shared TypeScript types matching the Drizzle schema ($inferSelect shape).
// No drizzle-orm runtime dependency — pure TypeScript interfaces only.

// ── Enums ────────────────────────────────────────────────────────────────────

export type CalculationType = 'percent_contract' | 'ppw' | 'tiered' | 'hybrid';
export type AssignmentRole = 'closer' | 'setter' | 'manager' | 'override_recipient';
export type EventType = 'earned' | 'adjusted' | 'clawed_back' | 'override_earned' | 'adder' | 'deduction';
export type EventStatus = 'pending' | 'approved' | 'paid' | 'disputed';
export type AdjustmentReason = 'redesign' | 'change_order' | 'bonus' | 'penalty' | 'manual';
export type StatementStatus = 'draft' | 'approved' | 'paid';

// ── JSONB shapes ──────────────────────────────────────────────────────────────

export interface OrgSettings {
  require_event_approval: boolean;
}

export interface CommissionRules {
  percent?: number;
  dollars_per_watt?: number;
  tiers?: Array<{ min_kw: number; max_kw: number | null; rate: number }>;
}

export interface PayableTrigger {
  type: 'stage' | 'days_after_earned' | 'manual_approval';
  value: string | number;
}

export interface ClawbackConfig {
  enabled: boolean;
  cancellation_stages: string[];
  clawback_percent: number;
  grace_period_days: number;
}

export interface RepAssignment {
  user_id: string;
  role: AssignmentRole;
  split_percent: number;
}

// ── Row types ─────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Org {
  id: string;
  name: string;
  settings: OrgSettings;
  createdAt: Date;
}

export interface CommissionPlan {
  id: string;
  orgId: string;
  name: string;
  calculationType: CalculationType;
  rules: CommissionRules;
  earnedTriggerStage: string;
  payableTrigger: PayableTrigger;
  clawbackConfig: ClawbackConfig | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanAssignment {
  id: string;
  planId: string;
  orgId: string;
  userId: string;
  role: AssignmentRole;
  defaultSplitPercent: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface ProjectCommissionConfig {
  id: string;
  projectId: string;
  orgId: string;
  repAssignments: RepAssignment[];
  planOverrideId: string | null;
  contractValue: string;
  systemSizeKw: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommissionEvent {
  id: string;
  orgId: string;
  projectId: string;
  userId: string;
  planId: string;
  eventType: EventType;
  amount: string;
  triggeringStageTransitionId: string | null;
  deliveryId: string | null;
  status: EventStatus;
  notes: string | null;
  createdAt: Date;
  createdBy: string;
}

export interface CommissionAdjustment {
  id: string;
  orgId: string;
  projectId: string;
  userId: string;
  amount: string;
  reason: AdjustmentReason;
  notes: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  commissionEventId: string | null;
  createdAt: Date;
}

export interface OverrideRule {
  id: string;
  orgId: string;
  managerUserId: string;
  teamMemberUserIds: string[];
  overridePercent: string;
  appliesToPlanIds: string[] | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface PayoutStatement {
  id: string;
  orgId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  totalEarned: string;
  totalClawedBack: string;
  totalAdjustments: string;
  netPayable: string;
  status: StatementStatus;
  approvedBy: string | null;
  eventIds: string[];
  createdAt: Date;
}

export interface AuditLogEntry {
  id: string;
  orgId: string;
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

// ── Insert types (id/timestamps optional) ────────────────────────────────────

export type NewCommissionPlan = Omit<CommissionPlan, 'id' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<CommissionPlan, 'id' | 'createdAt' | 'updatedAt'>>;

export type NewCommissionEvent = Omit<CommissionEvent, 'id' | 'createdAt'> &
  Partial<Pick<CommissionEvent, 'id' | 'createdAt'>>;
