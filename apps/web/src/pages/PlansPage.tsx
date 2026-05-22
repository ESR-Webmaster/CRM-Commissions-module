import { useState, useEffect, useCallback } from 'react';
import { listPlans, createPlan, updatePlan, endAndReplace, ApiError } from '../api';
import { useAuth } from '../auth';
import type { Plan, PlansResponse } from '../types';

const TRIGGER_STAGES = [
  'install_complete',
  'permit_approved',
  'ntp_approved',
  'funded',
  'closed',
  'commissioned',
];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function calcTypeLabel(t: string) {
  if (t === 'percent_contract') return '% Contract';
  if (t === 'ppw') return '$/Watt';
  if (t === 'tiered') return 'Tiered';
  return t;
}

function rulesDisplay(plan: Plan): string {
  const r = plan.rules;
  if (plan.calculationType === 'percent_contract' && r['percent'] !== undefined) {
    return `${r['percent']}%`;
  }
  if (plan.calculationType === 'ppw' && r['dollars_per_watt'] !== undefined) {
    return `$${r['dollars_per_watt']}/W`;
  }
  return JSON.stringify(r);
}

// ── Create / Edit form ───────────────────────────────────────────────────────

interface PlanFormValues {
  name: string;
  calculation_type: 'percent_contract' | 'ppw';
  percent: string;
  dollars_per_watt: string;
  earned_trigger_stage: string;
  payable_trigger_value: string;
  effective_from: string;
  effective_to: string;
}

function defaultFormValues(plan?: Plan): PlanFormValues {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  if (!plan) {
    return {
      name: '',
      calculation_type: 'percent_contract',
      percent: '',
      dollars_per_watt: '',
      earned_trigger_stage: 'install_complete',
      payable_trigger_value: 'install_complete',
      effective_from: tomorrow,
      effective_to: '',
    };
  }
  const r = plan.rules;
  return {
    name: plan.name,
    calculation_type: plan.calculationType === 'ppw' ? 'ppw' : 'percent_contract',
    percent: r['percent'] !== undefined ? String(r['percent']) : '',
    dollars_per_watt: r['dollars_per_watt'] !== undefined ? String(r['dollars_per_watt']) : '',
    earned_trigger_stage: plan.earnedTriggerStage,
    payable_trigger_value: (plan.payableTrigger as { value?: string }).value ?? plan.earnedTriggerStage,
    effective_from: plan.effectiveFrom.slice(0, 16),
    effective_to: plan.effectiveTo ? plan.effectiveTo.slice(0, 16) : '',
  };
}

function buildPayload(v: PlanFormValues): Record<string, unknown> {
  const rules: Record<string, number> =
    v.calculation_type === 'percent_contract'
      ? { percent: parseFloat(v.percent) }
      : { dollars_per_watt: parseFloat(v.dollars_per_watt) };

  const payload: Record<string, unknown> = {
    name: v.name,
    calculation_type: v.calculation_type,
    rules,
    earned_trigger_stage: v.earned_trigger_stage,
    payable_trigger: { type: 'stage', value: v.payable_trigger_value },
    effective_from: new Date(v.effective_from).toISOString(),
  };
  if (v.effective_to) payload['effective_to'] = new Date(v.effective_to).toISOString();
  return payload;
}

interface PlanFormModalProps {
  plan?: Plan;
  onClose: () => void;
  onSaved: () => void;
  onToast: (msg: string, type?: 'success' | 'error') => void;
}

function PlanFormModal({ plan, onClose, onSaved, onToast }: PlanFormModalProps) {
  const [values, setValues] = useState<PlanFormValues>(() => defaultFormValues(plan));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set(field: keyof PlanFormValues, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    setError('');
  }

  async function handleSubmit() {
    if (!values.name.trim()) { setError('Plan name is required'); return; }
    const effFrom = new Date(values.effective_from);
    if (isNaN(effFrom.getTime())) { setError('Effective from date is required'); return; }
    if (!plan && effFrom <= new Date()) { setError('Effective from must be in the future'); return; }
    const ruleVal = values.calculation_type === 'percent_contract'
      ? parseFloat(values.percent)
      : parseFloat(values.dollars_per_watt);
    if (isNaN(ruleVal) || ruleVal <= 0) {
      setError(`${values.calculation_type === 'percent_contract' ? 'Percent' : 'Dollars per watt'} must be > 0`);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const payload = buildPayload(values);
      if (plan) {
        await updatePlan(plan.id, payload);
        onToast('Plan updated');
      } else {
        await createPlan(payload);
        onToast('Plan created');
      }
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) setError('A plan with this name is already active');
        else if (e.status === 422) setError('Cannot change type/rules — events exist for this plan');
        else if (e.status === 400) setError('Validation failed — check field values');
        else setError(`Error ${e.status}`);
      } else {
        setError('Unexpected error');
      }
      setSaving(false);
    }
  }

  const isEditing = !!plan;

  return (
    <div className="modal-overlay">
      <div className="modal modal-wide">
        <div className="modal-header">
          <div className="modal-title">{isEditing ? 'Edit Plan' : 'Create Commission Plan'}</div>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-group">
            <label className="form-label">Plan Name</label>
            <input
              className="form-control"
              placeholder="e.g. Standard Closer Q3 2025"
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Calculation Type</label>
              <select
                className="form-control"
                value={values.calculation_type}
                disabled={isEditing}
                onChange={(e) => set('calculation_type', e.target.value as 'percent_contract' | 'ppw')}
              >
                <option value="percent_contract">% of Contract Value</option>
                <option value="ppw">$ per Watt (PPW)</option>
              </select>
              {isEditing && (
                <div className="form-hint">Type is immutable once events exist</div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">
                {values.calculation_type === 'percent_contract' ? 'Commission %' : '$/Watt'}
              </label>
              {values.calculation_type === 'percent_contract' ? (
                <input
                  className="form-control"
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  placeholder="e.g. 3.5"
                  value={values.percent}
                  onChange={(e) => set('percent', e.target.value)}
                />
              ) : (
                <input
                  className="form-control"
                  type="number"
                  min={0.001}
                  max={50}
                  step={0.001}
                  placeholder="e.g. 0.35"
                  value={values.dollars_per_watt}
                  onChange={(e) => set('dollars_per_watt', e.target.value)}
                />
              )}
              <div className="form-hint">
                {values.calculation_type === 'percent_contract'
                  ? 'Range: 0.01–100'
                  : 'Range: $0.001–$50.00'}
              </div>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Earned Trigger Stage</label>
              <select
                className="form-control"
                value={values.earned_trigger_stage}
                onChange={(e) => set('earned_trigger_stage', e.target.value)}
              >
                {TRIGGER_STAGES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <div className="form-hint">Stage that triggers commission earning</div>
            </div>

            <div className="form-group">
              <label className="form-label">Payable Trigger Stage</label>
              <select
                className="form-control"
                value={values.payable_trigger_value}
                onChange={(e) => set('payable_trigger_value', e.target.value)}
              >
                {TRIGGER_STAGES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <div className="form-hint">Stage that makes commission payable</div>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Effective From</label>
              <input
                className="form-control"
                type="datetime-local"
                value={values.effective_from}
                onChange={(e) => set('effective_from', e.target.value)}
              />
              {!isEditing && (
                <div className="form-hint">Must be in the future</div>
              )}
            </div>
            <div className="form-group">
              <label className="form-label">Effective To <span style={{ opacity: 0.5 }}>(optional)</span></label>
              <input
                className="form-control"
                type="datetime-local"
                value={values.effective_to}
                onChange={(e) => set('effective_to', e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => { void handleSubmit(); }}>
            {saving ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Saving…</> : isEditing ? 'Update Plan' : 'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── End & Replace modal ──────────────────────────────────────────────────────

interface EndAndReplaceModalProps {
  plan: Plan;
  onClose: () => void;
  onSaved: () => void;
  onToast: (msg: string, type?: 'success' | 'error') => void;
}

function EndAndReplaceModal({ plan, onClose, onSaved, onToast }: EndAndReplaceModalProps) {
  const [endDate, setEndDate] = useState('');
  const [overrideRules, setOverrideRules] = useState(false);
  const [ruleValue, setRuleValue] = useState(
    plan.calculationType === 'ppw'
      ? String(plan.rules['dollars_per_watt'] ?? '')
      : String(plan.rules['percent'] ?? ''),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    setSaving(true);
    setError('');
    const payload: Record<string, unknown> = {};
    if (endDate) payload['end_date'] = new Date(endDate).toISOString();
    if (overrideRules) {
      const v = parseFloat(ruleValue);
      if (isNaN(v) || v <= 0) {
        setError('Rule value must be > 0');
        setSaving(false);
        return;
      }
      payload['rules'] = plan.calculationType === 'ppw'
        ? { dollars_per_watt: v }
        : { percent: v };
    }
    try {
      await endAndReplace(plan.id, payload);
      onToast('Plan ended and replaced with new version');
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? `Error ${e.status}` : 'Failed');
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">End &amp; Replace Plan</div>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="alert alert-warning">
            This will mark <strong>{plan.name}</strong> as inactive and create a new active version
            inheriting all fields (with any overrides you specify below).
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-group">
            <label className="form-label">End Date <span style={{ opacity: 0.5 }}>(defaults to now)</span></label>
            <input
              className="form-control"
              type="datetime-local"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="toggle-wrapper">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={overrideRules}
                  onChange={(e) => setOverrideRules(e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
              <span>Override commission rate in new plan</span>
            </label>
          </div>

          {overrideRules && (
            <div className="form-group">
              <label className="form-label">
                New {plan.calculationType === 'ppw' ? '$/Watt' : 'Commission %'}
              </label>
              <input
                className="form-control"
                type="number"
                min={0.001}
                step={0.001}
                value={ruleValue}
                onChange={(e) => setRuleValue(e.target.value)}
              />
              <div className="form-hint">
                Current: {rulesDisplay(plan)}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={saving} onClick={() => { void handleSubmit(); }}>
            {saving
              ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Processing…</>
              : 'End & Replace'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main PlansPage ────────────────────────────────────────────────────────────

type ActiveFilter = 'all' | 'true' | 'false';
type TypeFilter = 'all' | 'percent_contract' | 'ppw';
type Modal = { type: 'create' } | { type: 'edit'; plan: Plan } | { type: 'end'; plan: Plan } | null;

interface Toast { msg: string; kind: 'success' | 'error'; }

export function PlansPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<PlansResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const LIMIT = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: Parameters<typeof listPlans>[0] = { page, limit: LIMIT };
      if (activeFilter !== 'all') params.is_active = activeFilter;
      if (typeFilter !== 'all') params.calculation_type = typeFilter;
      const result = await listPlans(params);
      setData(result);
    } catch (e) {
      setError(e instanceof ApiError
        ? e.status === 401 ? 'Token expired or invalid — please re-authenticate' : `Error ${e.status}`
        : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, [page, activeFilter, typeFilter]);

  useEffect(() => { void load(); }, [load]);

  function showToast(msg: string, kind: 'success' | 'error' = 'success') {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  }

  const totalPages = data ? Math.ceil(data.total / LIMIT) : 0;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Commission Plans</div>
          <div className="page-subtitle">
            {data ? `${data.total} plan${data.total !== 1 ? 's' : ''} total` : 'Loading…'}
          </div>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setModal({ type: 'create' })}>
            + New Plan
          </button>
        )}
      </div>

      <div className="page-content">
        {error && <div className="alert alert-error">⚠️ {error}</div>}

        <div className="filter-bar">
          <select
            className="filter-select"
            value={activeFilter}
            onChange={(e) => { setActiveFilter(e.target.value as ActiveFilter); setPage(1); }}
          >
            <option value="all">All statuses</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
          <select
            className="filter-select"
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value as TypeFilter); setPage(1); }}
          >
            <option value="all">All types</option>
            <option value="percent_contract">% Contract</option>
            <option value="ppw">$/Watt (PPW)</option>
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>↺ Refresh</button>
        </div>

        <div className="card">
          {loading ? (
            <div className="loading-center">
              <div className="spinner" /> Loading plans…
            </div>
          ) : !data || data.plans.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📋</div>
              <div className="empty-state-title">No plans found</div>
              <div className="empty-state-desc">
                {isAdmin ? 'Create your first commission plan to get started.' : 'No commission plans match the current filters.'}
              </div>
            </div>
          ) : (
            <>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Rate</th>
                      <th>Earned Trigger</th>
                      <th>Effective From</th>
                      <th>Effective To</th>
                      <th>Status</th>
                      {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.plans.map((plan) => (
                      <tr key={plan.id}>
                        <td style={{ fontWeight: 600 }}>{plan.name}</td>
                        <td>
                          <span className={`badge ${plan.calculationType === 'ppw' ? 'badge-blue' : 'badge-orange'}`}>
                            {calcTypeLabel(plan.calculationType)}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                          {rulesDisplay(plan)}
                        </td>
                        <td>
                          <span className="mono" style={{ fontSize: 12 }}>
                            {plan.earnedTriggerStage.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td style={{ color: 'var(--c-text-muted)', fontSize: 13 }}>
                          {formatDate(plan.effectiveFrom)}
                        </td>
                        <td style={{ color: 'var(--c-text-muted)', fontSize: 13 }}>
                          {plan.effectiveTo ? formatDate(plan.effectiveTo) : '—'}
                        </td>
                        <td>
                          {plan.isActive
                            ? <span className="badge badge-green">● Active</span>
                            : <span className="badge badge-gray">Inactive</span>}
                        </td>
                        {isAdmin && (
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => setModal({ type: 'edit', plan })}
                              >
                                Edit
                              </button>
                              {plan.isActive && (
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => setModal({ type: 'end', plan })}
                                >
                                  End &amp; Replace
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="pagination">
                  <span>
                    Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, data.total)} of {data.total}
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      ← Prev
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {modal?.type === 'create' && (
        <PlanFormModal
          onClose={() => setModal(null)}
          onSaved={() => { void load(); }}
          onToast={showToast}
        />
      )}
      {modal?.type === 'edit' && (
        <PlanFormModal
          plan={modal.plan}
          onClose={() => setModal(null)}
          onSaved={() => { void load(); }}
          onToast={showToast}
        />
      )}
      {modal?.type === 'end' && (
        <EndAndReplaceModal
          plan={modal.plan}
          onClose={() => setModal(null)}
          onSaved={() => { void load(); }}
          onToast={showToast}
        />
      )}

      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.kind}`}>
            {toast.kind === 'success' ? '✓' : '✕'} {toast.msg}
          </div>
        </div>
      )}
    </>
  );
}
