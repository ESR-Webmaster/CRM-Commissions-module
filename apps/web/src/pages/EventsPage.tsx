import { useState, useEffect, useCallback } from 'react';
import { listEvents, listMyEvents, patchEventStatus, bulkEventStatus, disputeEvent } from '../api';
import type { ListEventsParams } from '../api';
import { useAuth } from '../auth';
import type { CommissionEvent, EventStatus, EventsResponse } from '../types';

function fmt(val: string): string {
  const n = Number(val);
  if (isNaN(n)) return '$0';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function shortId(id: string): string {
  return id.slice(0, 8) + '…';
}

function DisputeModal({
  event,
  onClose,
  onDone,
}: {
  event: CommissionEvent;
  onClose: () => void;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!notes.trim()) { setError('Notes required'); return; }
    setLoading(true);
    setError(null);
    try {
      await disputeEvent(event.id, notes);
      onDone();
    } catch {
      setError('Failed to dispute event');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Dispute Event</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: 12, color: 'var(--c-muted)' }}>
            Event: {shortId(event.id)} · {fmt(event.amount)}
          </p>
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="form-group">
            <label className="form-label">Reason for dispute *</label>
            <textarea
              className="form-control"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Explain why this commission is incorrect…"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={() => { void submit(); }} disabled={loading}>
            {loading ? 'Submitting…' : 'Submit Dispute'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EventsPage() {
  const { isAdmin } = useAuth();
  const [events, setEvents] = useState<CommissionEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [disputingEvent, setDisputingEvent] = useState<CommissionEvent | null>(null);
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
      const params: ListEventsParams = { page, limit };
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.event_type = typeFilter;
      let resp: EventsResponse;
      if (isAdmin) {
        resp = await listEvents(params);
      } else {
        resp = await listMyEvents(params);
      }
      setEvents(resp.events);
      setTotal(resp.total);
      setSelected(new Set());
    } catch {
      setError('Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, statusFilter, typeFilter, page]);

  useEffect(() => { void load(); }, [load]);

  async function handleBulkApprove() {
    if (selected.size === 0) return;
    setActionLoading(true);
    try {
      await bulkEventStatus([...selected], 'approved');
      showToast(`Approved ${selected.size} event(s)`);
      void load();
    } catch {
      showToast('Bulk approve failed');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleBulkPaid() {
    if (selected.size === 0) return;
    setActionLoading(true);
    try {
      await bulkEventStatus([...selected], 'paid');
      showToast(`Marked ${selected.size} event(s) as paid`);
      void load();
    } catch {
      showToast('Bulk paid failed');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSingleStatus(event: CommissionEvent, status: 'approved' | 'disputed' | 'paid') {
    setActionLoading(true);
    try {
      await patchEventStatus(event.id, status);
      showToast(`Event ${status}`);
      void load();
    } catch {
      showToast('Update failed');
    } finally {
      setActionLoading(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === events.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(events.map((e) => e.id)));
    }
  }

  const pages = Math.ceil(total / limit);

  return (
    <div className="page">
      {toast && <div className="toast">{toast}</div>}
      {disputingEvent && (
        <DisputeModal
          event={disputingEvent}
          onClose={() => setDisputingEvent(null)}
          onDone={() => { setDisputingEvent(null); void load(); }}
        />
      )}

      <div className="page-header">
        <h1 className="page-title">{isAdmin ? 'All Events' : 'My Events'}</h1>
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <select
          className="form-control"
          style={{ width: 160 }}
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="paid">Paid</option>
          <option value="disputed">Disputed</option>
        </select>
        <select
          className="form-control"
          style={{ width: 180 }}
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Types</option>
          <option value="earned">Earned</option>
          <option value="override_earned">Override Earned</option>
          <option value="adjusted">Adjusted</option>
          <option value="clawed_back">Clawed Back</option>
          <option value="adder">Adder</option>
          <option value="deduction">Deduction</option>
        </select>

        {isAdmin && selected.size > 0 && (
          <>
            <button
              className="btn btn-sm"
              onClick={() => { void handleBulkApprove(); }}
              disabled={actionLoading}
            >
              Approve {selected.size}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => { void handleBulkPaid(); }}
              disabled={actionLoading}
            >
              Mark Paid {selected.size}
            </button>
          </>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              {isAdmin && (
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={selected.size === events.length && events.length > 0} onChange={toggleAll} />
                </th>
              )}
              <th>ID</th>
              <th>Project</th>
              {isAdmin && <th>Rep</th>}
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={isAdmin ? 9 : 8} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>Loading…</td></tr>
            )}
            {!loading && events.length === 0 && (
              <tr><td colSpan={isAdmin ? 9 : 8} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>No events found</td></tr>
            )}
            {events.map((ev) => (
              <tr key={ev.id}>
                {isAdmin && (
                  <td>
                    <input type="checkbox" checked={selected.has(ev.id)} onChange={() => toggleSelect(ev.id)} />
                  </td>
                )}
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{shortId(ev.id)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{shortId(ev.projectId)}</td>
                {isAdmin && <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{shortId(ev.userId)}</td>}
                <td>
                  <span className={`badge badge-type-${ev.eventType.replace('_', '-')}`}>
                    {ev.eventType.replace(/_/g, ' ')}
                  </span>
                </td>
                <td style={{ fontWeight: 600 }}>{fmt(ev.amount)}</td>
                <td><span className={`badge badge-${ev.status}`}>{ev.status}</span></td>
                <td style={{ fontSize: 12, color: 'var(--c-muted)' }}>
                  {new Date(ev.createdAt).toLocaleDateString()}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {isAdmin && ev.status === 'pending' && (
                      <button
                        className="btn btn-xs"
                        onClick={() => { void handleSingleStatus(ev, 'approved'); }}
                        disabled={actionLoading}
                      >
                        Approve
                      </button>
                    )}
                    {!isAdmin && ev.status === 'pending' && (
                      <button
                        className="btn btn-xs btn-danger"
                        onClick={() => setDisputingEvent(ev)}
                      >
                        Dispute
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
            <button className="btn btn-sm btn-ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
              ← Prev
            </button>
            <span style={{ color: 'var(--c-muted)', fontSize: 13 }}>
              Page {page} of {pages} · {total} total
            </span>
            <button className="btn btn-sm btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
