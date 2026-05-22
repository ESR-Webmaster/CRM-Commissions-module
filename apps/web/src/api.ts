import type {
  Plan, PlansResponse, OrgSettings, HealthStatus, HealthReady, HealthVersion,
  EventsResponse, DashboardData, CommissionEvent,
  AssignmentsResponse, Assignment,
  ProjectsResponse, ProjectConfig, ProjectedCommission,
  StatementsResponse, PayoutStatement,
  UsersResponse, AuditResponse, AdjustmentsResponse, Adjustment, OverrideRulesResponse, OverrideRule,
} from './types';

let _token: string | null = null;

export function setApiToken(token: string | null): void {
  _token = token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API error ${status}`);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (_token) headers.set('Authorization', `Bearer ${_token}`);

  const res = await fetch(path, { ...init, headers });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

async function requestNoAuth<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// ── Plans ────────────────────────────────────────────────────────────────────

export interface ListPlansParams {
  is_active?: 'true' | 'false';
  calculation_type?: string;
  page?: number;
  limit?: number;
}

export async function listPlans(params: ListPlansParams = {}): Promise<PlansResponse> {
  const qs = new URLSearchParams();
  if (params.is_active !== undefined) qs.set('is_active', params.is_active);
  if (params.calculation_type) qs.set('calculation_type', params.calculation_type);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<PlansResponse>(`/api/v1/plans${q ? `?${q}` : ''}`);
}

export async function createPlan(data: Record<string, unknown>): Promise<Plan> {
  return request<Plan>('/api/v1/plans', { method: 'POST', body: JSON.stringify(data) });
}

export async function updatePlan(id: string, data: Record<string, unknown>): Promise<Plan> {
  return request<Plan>(`/api/v1/plans/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function endAndReplace(
  id: string,
  data: Record<string, unknown>,
): Promise<{ ended: Plan; created: Plan }> {
  return request<{ ended: Plan; created: Plan }>(
    `/api/v1/plans/${id}/end-and-replace`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

// ── Org settings ─────────────────────────────────────────────────────────────

export async function getOrgSettings(): Promise<OrgSettings> {
  return request<OrgSettings>('/api/v1/orgs/me/settings');
}

export async function patchOrgSettings(data: { require_event_approval: boolean }): Promise<OrgSettings> {
  return request<OrgSettings>('/api/v1/orgs/me/settings', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ── Health ───────────────────────────────────────────────────────────────────

export async function getHealth(): Promise<HealthStatus> {
  return requestNoAuth<HealthStatus>('/health');
}

export async function getHealthReady(): Promise<HealthReady> {
  return requestNoAuth<HealthReady>('/health/ready');
}

export async function getHealthVersion(): Promise<HealthVersion> {
  return requestNoAuth<HealthVersion>('/health/version');
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface ListEventsParams {
  user_id?: string;
  project_id?: string;
  status?: string;
  event_type?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export async function listEvents(params: ListEventsParams = {}): Promise<EventsResponse> {
  const qs = new URLSearchParams();
  if (params.user_id) qs.set('user_id', params.user_id);
  if (params.project_id) qs.set('project_id', params.project_id);
  if (params.status) qs.set('status', params.status);
  if (params.event_type) qs.set('event_type', params.event_type);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<EventsResponse>(`/api/v1/events${q ? `?${q}` : ''}`);
}

export async function listMyEvents(params: ListEventsParams = {}): Promise<EventsResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.event_type) qs.set('event_type', params.event_type);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<EventsResponse>(`/api/v1/events/me/events${q ? `?${q}` : ''}`);
}

export async function getDashboard(): Promise<DashboardData> {
  return request<DashboardData>('/api/v1/events/me/dashboard');
}

export async function patchEventStatus(
  id: string,
  status: 'approved' | 'disputed' | 'paid',
  notes?: string,
): Promise<CommissionEvent> {
  return request<CommissionEvent>(`/api/v1/events/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, notes }),
  });
}

export async function bulkEventStatus(
  event_ids: string[],
  status: 'approved' | 'disputed' | 'paid',
  notes?: string,
): Promise<{ updated: number; status: string }> {
  return request<{ updated: number; status: string }>('/api/v1/events/bulk-status', {
    method: 'POST',
    body: JSON.stringify({ event_ids, status, notes }),
  });
}

export async function disputeEvent(id: string, notes: string): Promise<CommissionEvent> {
  return request<CommissionEvent>(`/api/v1/events/${id}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ notes }),
  });
}

// ── Plan Assignments ──────────────────────────────────────────────────────────

export interface ListAssignmentsParams {
  user_id?: string;
  plan_id?: string;
  is_active?: 'true' | 'false';
  page?: number;
  limit?: number;
}

export async function listAssignments(params: ListAssignmentsParams = {}): Promise<AssignmentsResponse> {
  const qs = new URLSearchParams();
  if (params.user_id) qs.set('user_id', params.user_id);
  if (params.plan_id) qs.set('plan_id', params.plan_id);
  if (params.is_active) qs.set('is_active', params.is_active);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<AssignmentsResponse>(`/api/v1/plan-assignments${q ? `?${q}` : ''}`);
}

export async function createAssignment(data: Record<string, unknown>): Promise<Assignment> {
  return request<Assignment>('/api/v1/plan-assignments', { method: 'POST', body: JSON.stringify(data) });
}

export async function deactivateAssignment(id: string): Promise<{ id: string; effectiveTo: string }> {
  return request<{ id: string; effectiveTo: string }>(`/api/v1/plan-assignments/${id}`, { method: 'DELETE' });
}

// ── Projects ──────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectsResponse> {
  return request<ProjectsResponse>('/api/v1/projects');
}

export async function upsertProject(data: Record<string, unknown>): Promise<ProjectConfig> {
  return request<ProjectConfig>('/api/v1/projects', { method: 'POST', body: JSON.stringify(data) });
}

export async function getProject(projectId: string): Promise<ProjectConfig> {
  return request<ProjectConfig>(`/api/v1/projects/${projectId}`);
}

export async function getProjectedCommission(
  projectId: string,
  hypotheticalStage: string,
): Promise<ProjectedCommission> {
  return request<ProjectedCommission>(
    `/api/v1/projects/${projectId}/projected-commission?hypothetical_stage=${encodeURIComponent(hypotheticalStage)}`,
  );
}

export async function simulateTransition(data: {
  project_id: string;
  from_stage: string;
  to_stage: string;
  transition_id: string;
  occurred_at?: string;
}): Promise<{ events_created: number; events_already_existed: number; event_ids: string[] }> {
  return request('/api/v1/webhooks/stage-transition', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Statements ────────────────────────────────────────────────────────────────

export interface ListStatementsParams {
  user_id?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export async function listStatements(params: ListStatementsParams = {}): Promise<StatementsResponse> {
  const qs = new URLSearchParams();
  if (params.user_id) qs.set('user_id', params.user_id);
  if (params.status) qs.set('status', params.status);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<StatementsResponse>(`/api/v1/statements${q ? `?${q}` : ''}`);
}

export async function generateStatement(data: {
  rep_user_id: string;
  period_start: string;
  period_end: string;
}): Promise<PayoutStatement> {
  return request<PayoutStatement>('/api/v1/statements/generate', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function approveStatement(id: string): Promise<PayoutStatement> {
  return request<PayoutStatement>(`/api/v1/statements/${id}/approve`, { method: 'POST', body: '{}' });
}

export async function markStatementPaid(id: string): Promise<PayoutStatement> {
  return request<PayoutStatement>(`/api/v1/statements/${id}/mark-paid`, { method: 'POST', body: '{}' });
}

export function getStatementCsvUrl(id: string): string {
  return `/api/v1/statements/${id}/csv`;
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<UsersResponse> {
  return request<UsersResponse>('/api/v1/users');
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface ListAuditParams {
  entity_type?: string;
  entity_id?: string;
  actor_user_id?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export async function listAudit(params: ListAuditParams = {}): Promise<AuditResponse> {
  const qs = new URLSearchParams();
  if (params.entity_type) qs.set('entity_type', params.entity_type);
  if (params.entity_id) qs.set('entity_id', params.entity_id);
  if (params.actor_user_id) qs.set('actor_user_id', params.actor_user_id);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<AuditResponse>(`/api/v1/audit${q ? `?${q}` : ''}`);
}

// ── Adjustments ──────────────────────────────────────────────────────────────

export interface ListAdjustmentsParams {
  project_id?: string;
  user_id?: string;
  page?: number;
  limit?: number;
}

export async function listAdjustments(params: ListAdjustmentsParams = {}): Promise<AdjustmentsResponse> {
  const qs = new URLSearchParams();
  if (params.project_id) qs.set('project_id', params.project_id);
  if (params.user_id) qs.set('user_id', params.user_id);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<AdjustmentsResponse>(`/api/v1/adjustments${q ? `?${q}` : ''}`);
}

export async function createAdjustment(data: {
  project_id: string;
  user_id: string;
  amount: number;
  reason: string;
  notes?: string;
}): Promise<Adjustment> {
  return request<Adjustment>('/api/v1/adjustments', { method: 'POST', body: JSON.stringify(data) });
}

// ── Override Rules ────────────────────────────────────────────────────────────

export async function listOverrideRules(params: { page?: number; limit?: number } = {}): Promise<OverrideRulesResponse> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<OverrideRulesResponse>(`/api/v1/override-rules${q ? `?${q}` : ''}`);
}

export async function createOverrideRule(data: {
  manager_user_id: string;
  team_member_user_ids: string[];
  override_percent: number;
  applies_to_plan_ids?: string[];
  effective_from: string;
  effective_to?: string;
}): Promise<OverrideRule> {
  return request<OverrideRule>('/api/v1/override-rules', { method: 'POST', body: JSON.stringify(data) });
}

export async function deleteOverrideRule(id: string): Promise<{ id: string; deleted: boolean }> {
  return request<{ id: string; deleted: boolean }>(`/api/v1/override-rules/${id}`, { method: 'DELETE' });
}
