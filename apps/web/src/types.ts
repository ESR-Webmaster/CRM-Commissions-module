export interface Plan {
  id: string;
  orgId: string;
  name: string;
  calculationType: 'percent_contract' | 'ppw' | 'tiered' | 'hybrid';
  rules: Record<string, number>;
  earnedTriggerStage: string;
  payableTrigger: { type: string; value: string };
  clawbackConfig: Record<string, unknown> | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlansResponse {
  plans: Plan[];
  total: number;
  page: number;
  limit: number;
}

export interface OrgSettings {
  requireEventApproval: boolean;
}

export interface HealthStatus {
  status: 'ok' | 'error';
}

export interface HealthReady {
  status: 'ok' | 'error';
  migrationHash?: string;
}

export interface HealthVersion {
  version: string;
  buildSha?: string;
}

export interface DecodedToken {
  org_id: string;
  user_id: string;
  role: 'admin' | 'rep';
  exp?: number;
  iat?: number;
}

export type Page =
  | 'dashboard'
  | 'plans'
  | 'events'
  | 'assignments'
  | 'projects'
  | 'statements'
  | 'users'
  | 'adjustments'
  | 'override-rules'
  | 'audit'
  | 'org-settings'
  | 'health'
  | 'setup';

// ── Events ───────────────────────────────────────────────────────────────────

export type EventStatus = 'pending' | 'approved' | 'paid' | 'disputed';
export type EventType = 'earned' | 'adjusted' | 'clawed_back' | 'override_earned' | 'adder' | 'deduction';

export interface CommissionEvent {
  id: string;
  orgId: string;
  projectId: string;
  userId: string;
  planId: string;
  eventType: EventType;
  amount: string;
  status: EventStatus;
  notes: string | null;
  triggeringStageTransitionId: string | null;
  deliveryId: string | null;
  createdAt: string;
  createdBy: string;
}

export interface EventsResponse {
  events: CommissionEvent[];
  total: number;
  page: number;
  limit: number;
}

export interface DashboardData {
  mtd: { total: string; count: number };
  qtd: { total: string; count: number };
  ytd: { total: string; count: number };
  by_status: Record<string, { total: string; count: number }>;
}

// ── Assignments ───────────────────────────────────────────────────────────────

export interface Assignment {
  id: string;
  orgId: string;
  planId: string;
  userId: string;
  role: 'closer' | 'setter' | 'manager' | 'override_recipient';
  defaultSplitPercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface AssignmentsResponse {
  assignments: Assignment[];
  total: number;
  page: number;
  limit: number;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export interface RepAssignment {
  user_id: string;
  role: string;
  split_percent: number;
}

export interface ProjectConfig {
  id: string;
  orgId: string;
  projectId: string;
  repAssignments: RepAssignment[];
  planOverrideId: string | null;
  contractValue: string;
  systemSizeKw: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectsResponse {
  projects: ProjectConfig[];
  total: number;
}

export interface ProjectedCommission {
  plan_id: string;
  plan_name: string;
  projections: Array<{ user_id: string; amount: string; explanation: string }>;
  reason?: string;
}

// ── Statements ────────────────────────────────────────────────────────────────

export interface StatementLineItem {
  eventId: string;
  projectId: string;
  eventType: EventType;
  amount: string;
  eventDate: string;
  planName?: string;
}

export interface PayoutStatement {
  id: string;
  orgId: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  totalEarned: string;
  totalClawedBack: string;
  totalAdjustments: string;
  netPayable: string;
  status: 'draft' | 'approved' | 'paid';
  approvedBy: string | null;
  eventIds: string[];
  createdAt: string;
}

export interface StatementsResponse {
  statements: PayoutStatement[];
  total: number;
  page: number;
  limit: number;
}

// ── Users ────────────────────────────────────────────────────────────────────

export interface OrgUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsersResponse {
  users: OrgUser[];
  total: number;
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  orgId: string;
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditResponse {
  entries: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
}

// ── Adjustments ──────────────────────────────────────────────────────────────

export type AdjustmentReason = 'redesign' | 'change_order' | 'bonus' | 'penalty' | 'manual';

export interface Adjustment {
  id: string;
  orgId: string;
  projectId: string;
  userId: string;
  amount: string;
  reason: AdjustmentReason;
  notes: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  commissionEventId: string | null;
  createdAt: string;
}

export interface AdjustmentsResponse {
  adjustments: Adjustment[];
  total: number;
  page: number;
  limit: number;
}

// ── Override Rules ────────────────────────────────────────────────────────────

export interface OverrideRule {
  id: string;
  orgId: string;
  managerUserId: string;
  teamMemberUserIds: string[];
  overridePercent: string;
  appliesToPlanIds: string[] | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface OverrideRulesResponse {
  rules: OverrideRule[];
  total: number;
  page: number;
  limit: number;
}
