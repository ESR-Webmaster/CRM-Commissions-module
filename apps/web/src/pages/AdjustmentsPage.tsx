import { useEffect, useState } from 'react';
import { listAdjustments, createAdjustment } from '../api';
import type { Adjustment, AdjustmentReason } from '../types';

const REASONS: AdjustmentReason[] = ['redesign', 'change_order', 'bonus', 'penalty', 'manual'];

export function AdjustmentsPage() {
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<AdjustmentReason>('manual');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState('');

  const limit = 20;

  function load(p: number) {
    setLoading(true);
    setError('');
    listAdjustments({ page: p, limit })
      .then((r) => { setAdjustments(r.adjustments); setTotal(r.total); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load adjustments'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!projectId.trim() || !userId.trim() || isNaN(amt)) {
      setFormError('Project ID, User ID, and Amount are required.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const data: Parameters<typeof createAdjustment>[0] = { project_id: projectId.trim(), user_id: userId.trim(), amount: amt, reason };
      if (notes.trim()) data.notes = notes.trim();
      await createAdjustment(data);
      setProjectId(''); setUserId(''); setAmount(''); setReason('manual'); setNotes('');
      setShowForm(false);
      load(1);
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to create adjustment');
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.ceil(total / limit);
  const fmt = (v: string) => `$${parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Commission Adjustments</div>
          <div className="page-sub">{total} total adjustments</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ New Adjustment'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Create Adjustment</div>
          {formError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{formError}</div>}
          <form onSubmit={(e) => { void handleCreate(e); }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Project ID (UUID)</label>
                <input className="form-control mono" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="UUID" required />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">User ID (UUID)</label>
                <input className="form-control mono" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="UUID" required />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Amount ($)</label>
                <input className="form-control" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Reason</label>
                <select className="form-control" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
                  {REASONS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group" style={{ margin: '0 0 12px' }}>
              <label className="form-label">Notes (optional)</label>
              <textarea className="form-control" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Create Adjustment'}
            </button>
          </form>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Reason</th>
                  <th>Project</th>
                  <th>User</th>
                  <th>Notes</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--c-text-muted)' }}>No adjustments yet.</td>
                  </tr>
                ) : (
                  adjustments.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 600, color: parseFloat(a.amount) < 0 ? 'var(--c-danger)' : 'var(--c-success)' }}>
                        {fmt(a.amount)}
                      </td>
                      <td><span className="badge badge-type-earned">{a.reason.replace('_', ' ')}</span></td>
                      <td className="mono" style={{ fontSize: 11 }}>{a.projectId.slice(0, 8)}…</td>
                      <td className="mono" style={{ fontSize: 11 }}>{a.userId.slice(0, 8)}…</td>
                      <td style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>{a.notes ?? '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
                        {new Date(a.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
              <span style={{ fontSize: 13 }}>Page {page} of {totalPages}</span>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
