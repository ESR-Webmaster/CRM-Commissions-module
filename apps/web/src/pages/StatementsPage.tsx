import { useState, useEffect, useCallback } from 'react';
import { listStatements, generateStatement, approveStatement, markStatementPaid, getStatementCsvUrl } from '../api';
import type { ListStatementsParams } from '../api';
import { useAuth } from '../auth';
import type { PayoutStatement, StatementsResponse } from '../types';

function fmt(val: string): string {
  const n = Number(val);
  if (isNaN(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [repUserId, setRepUserId] = useState('');
  const [periodStart, setPeriodStart] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!repUserId) { setError('Rep User ID required'); return; }
    setLoading(true);
    setError(null);
    try {
      await generateStatement({
        rep_user_id: repUserId,
        period_start: new Date(periodStart).toISOString(),
        period_end: new Date(periodEnd + 'T23:59:59Z').toISOString(),
      });
      onDone();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate statement';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Generate Payout Statement</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

          <div className="form-group">
            <label className="form-label">Rep User ID *</label>
            <input className="form-control" value={repUserId} onChange={(e) => setRepUserId(e.target.value)} placeholder="UUID of the rep" />
          </div>

          <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Period Start</label>
              <input type="date" className="form-control" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Period End</label>
              <input type="date" className="form-control" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => { void submit(); }} disabled={loading}>
            {loading ? 'Generating…' : 'Generate Statement'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StatementsPage() {
  const { isAdmin } = useAuth();
  const [statements, setStatements] = useState<PayoutStatement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
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
      const stmtParams: ListStatementsParams = { page, limit };
      if (statusFilter) stmtParams.status = statusFilter;
      const resp = await listStatements(stmtParams) as StatementsResponse;
      setStatements(resp.statements);
      setTotal(resp.total);
    } catch {
      setError('Failed to load statements');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => { void load(); }, [load]);

  async function handleApprove(id: string) {
    setActionLoading(true);
    try {
      await approveStatement(id);
      showToast('Statement approved');
      void load();
    } catch {
      showToast('Approve failed');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleMarkPaid(id: string) {
    setActionLoading(true);
    try {
      await markStatementPaid(id);
      showToast('Statement marked as paid');
      void load();
    } catch {
      showToast('Mark paid failed');
    } finally {
      setActionLoading(false);
    }
  }

  function handleCsvDownload(id: string) {
    const url = getStatementCsvUrl(id);
    window.open(url, '_blank');
  }

  const pages = Math.ceil(total / limit);

  return (
    <div className="page">
      {toast && <div className="toast">{toast}</div>}
      {showGenerate && (
        <GenerateModal
          onClose={() => setShowGenerate(false)}
          onDone={() => { setShowGenerate(false); void load(); }}
        />
      )}

      <div className="page-header">
        <h1 className="page-title">Payout Statements</h1>
        {isAdmin && (
          <button className="btn" onClick={() => setShowGenerate(true)}>+ Generate Statement</button>
        )}
      </div>

      <div className="filter-bar">
        <select
          className="form-control"
          style={{ width: 160 }}
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="approved">Approved</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              {isAdmin && <th>Rep</th>}
              <th>Period</th>
              <th>Earned</th>
              <th>Clawbacks</th>
              <th>Net Payable</th>
              <th>Status</th>
              <th>Events</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={isAdmin ? 9 : 8} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>Loading…</td></tr>
            )}
            {!loading && statements.length === 0 && (
              <tr><td colSpan={isAdmin ? 9 : 8} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>No statements found</td></tr>
            )}
            {statements.map((s) => (
              <tr key={s.id}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.id.slice(0, 8)}…</td>
                {isAdmin && <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.userId.slice(0, 8)}…</td>}
                <td style={{ fontSize: 12 }}>
                  {new Date(s.periodStart).toLocaleDateString()} –{' '}
                  {new Date(s.periodEnd).toLocaleDateString()}
                </td>
                <td style={{ color: '#22c55e' }}>{fmt(s.totalEarned)}</td>
                <td style={{ color: '#ef4444' }}>{fmt(s.totalClawedBack)}</td>
                <td style={{ fontWeight: 700 }}>{fmt(s.netPayable)}</td>
                <td><span className={`badge badge-${s.status}`}>{s.status}</span></td>
                <td>{s.eventIds.length}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn btn-xs btn-ghost"
                      onClick={() => handleCsvDownload(s.id)}
                      title="Download CSV"
                    >
                      CSV
                    </button>
                    {isAdmin && s.status === 'draft' && (
                      <button
                        className="btn btn-xs"
                        onClick={() => { void handleApprove(s.id); }}
                        disabled={actionLoading}
                      >
                        Approve
                      </button>
                    )}
                    {isAdmin && s.status === 'approved' && (
                      <button
                        className="btn btn-xs btn-ghost"
                        onClick={() => { void handleMarkPaid(s.id); }}
                        disabled={actionLoading}
                      >
                        Mark Paid
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {pages > 1 && (
          <div className="pagination">
            <button className="btn btn-sm btn-ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>Page {page} of {pages} · {total} total</span>
            <button className="btn btn-sm btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
