import { useState, useEffect, useCallback } from 'react';
import { listAssignments, createAssignment, deactivateAssignment, listPlans } from '../api';
import type { ListAssignmentsParams } from '../api';
import { useAuth } from '../auth';
import type { Assignment, AssignmentsResponse, Plan } from '../types';

interface CreateAssignmentForm {
  plan_id: string;
  user_id: string;
  role: string;
  default_split_percent: string;
  effective_from: string;
  effective_to: string;
}

function CreateModal({
  plans,
  onClose,
  onDone,
}: {
  plans: Plan[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<CreateAssignmentForm>({
    plan_id: plans[0]?.id ?? '',
    user_id: '',
    role: 'closer',
    default_split_percent: '100',
    effective_from: new Date().toISOString().slice(0, 16),
    effective_to: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof CreateAssignmentForm>(k: K, v: CreateAssignmentForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        plan_id: form.plan_id,
        user_id: form.user_id,
        role: form.role,
        default_split_percent: Number(form.default_split_percent),
        effective_from: new Date(form.effective_from).toISOString(),
      };
      if (form.effective_to) body['effective_to'] = new Date(form.effective_to).toISOString();
      await createAssignment(body);
      onDone();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create assignment';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Create Assignment</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

          <div className="form-group">
            <label className="form-label">Plan</label>
            <select className="form-control" value={form.plan_id} onChange={(e) => set('plan_id', e.target.value)}>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">User ID *</label>
            <input className="form-control" value={form.user_id} onChange={(e) => set('user_id', e.target.value)} placeholder="UUID of the rep" />
          </div>

          <div className="form-group">
            <label className="form-label">Role</label>
            <select className="form-control" value={form.role} onChange={(e) => set('role', e.target.value)}>
              <option value="closer">Closer</option>
              <option value="setter">Setter</option>
              <option value="manager">Manager</option>
              <option value="override_recipient">Override Recipient</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Default Split %</label>
            <input
              type="number" min="0.01" max="100" step="0.01"
              className="form-control"
              value={form.default_split_percent}
              onChange={(e) => set('default_split_percent', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Effective From *</label>
            <input type="datetime-local" className="form-control" value={form.effective_from} onChange={(e) => set('effective_from', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">Effective To (optional)</label>
            <input type="datetime-local" className="form-control" value={form.effective_to} onChange={(e) => set('effective_to', e.target.value)} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => { void submit(); }} disabled={loading}>
            {loading ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AssignmentsPage() {
  const { isAdmin } = useAuth();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [activeFilter, setActiveFilter] = useState<'true' | 'false' | ''>('true');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const limit = 20;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const assignmentParams: ListAssignmentsParams = { page, limit };
      if (activeFilter) assignmentParams.is_active = activeFilter;
      const [resp, plansResp] = await Promise.all([
        listAssignments(assignmentParams) as Promise<AssignmentsResponse>,
        listPlans({ is_active: 'true', limit: 100 }),
      ]);
      setAssignments(resp.assignments);
      setTotal(resp.total);
      setPlans(plansResp.plans);
    } catch {
      setError('Failed to load assignments');
    } finally {
      setLoading(false);
    }
  }, [activeFilter, page]);

  useEffect(() => { void load(); }, [load]);

  async function handleDeactivate(id: string) {
    try {
      await deactivateAssignment(id);
      showToast('Assignment deactivated');
      void load();
    } catch {
      showToast('Failed to deactivate');
    }
  }

  const pages = Math.ceil(total / limit);

  return (
    <div className="page">
      {toast && <div className="toast">{toast}</div>}
      {showCreate && (
        <CreateModal
          plans={plans}
          onClose={() => setShowCreate(false)}
          onDone={() => { setShowCreate(false); void load(); }}
        />
      )}

      <div className="page-header">
        <h1 className="page-title">Plan Assignments</h1>
        {isAdmin && (
          <button className="btn" onClick={() => setShowCreate(true)}>+ New Assignment</button>
        )}
      </div>

      <div className="filter-bar">
        <select
          className="form-control"
          style={{ width: 160 }}
          value={activeFilter}
          onChange={(e) => { setActiveFilter(e.target.value as 'true' | 'false' | ''); setPage(1); }}
        >
          <option value="true">Active Only</option>
          <option value="false">Inactive Only</option>
          <option value="">All</option>
        </select>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>User ID</th>
              <th>Plan ID</th>
              <th>Role</th>
              <th>Split %</th>
              <th>Effective From</th>
              <th>Effective To</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={isAdmin ? 7 : 6} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>Loading…</td></tr>
            )}
            {!loading && assignments.length === 0 && (
              <tr><td colSpan={isAdmin ? 7 : 6} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>No assignments found</td></tr>
            )}
            {assignments.map((a) => (
              <tr key={a.id}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.userId.slice(0, 12)}…</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.planId.slice(0, 12)}…</td>
                <td><span className="badge">{a.role}</span></td>
                <td>{a.defaultSplitPercent}%</td>
                <td style={{ fontSize: 12 }}>{new Date(a.effectiveFrom).toLocaleDateString()}</td>
                <td style={{ fontSize: 12, color: 'var(--c-muted)' }}>
                  {a.effectiveTo ? new Date(a.effectiveTo).toLocaleDateString() : '—'}
                </td>
                {isAdmin && (
                  <td>
                    {!a.effectiveTo && (
                      <button className="btn btn-xs btn-ghost" onClick={() => { void handleDeactivate(a.id); }}>
                        Deactivate
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {pages > 1 && (
          <div className="pagination">
            <button className="btn btn-sm btn-ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>Page {page} of {pages}</span>
            <button className="btn btn-sm btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
