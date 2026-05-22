import { useEffect, useState } from 'react';
import { listAudit } from '../api';
import type { AuditLogEntry } from '../types';

export function AuditPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [entityType, setEntityType] = useState('');
  const [actorUserId, setActorUserId] = useState('');

  const limit = 25;

  function load(p: number) {
    setLoading(true);
    setError('');
    const params: Parameters<typeof listAudit>[0] = { page: p, limit };
    if (entityType) params.entity_type = entityType;
    if (actorUserId) params.actor_user_id = actorUserId;
    listAudit(params)
      .then((r) => { setEntries(r.entries); setTotal(r.total); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load audit log'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(page); }, [page]);  // eslint-disable-line react-hooks/exhaustive-deps

  function handleFilter(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    load(1);
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Audit Log</div>
          <div className="page-sub">Immutable record of all admin actions</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handleFilter} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0, minWidth: 180 }}>
            <label className="form-label">Entity Type</label>
            <input
              className="form-control"
              placeholder="e.g. adjustment"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ margin: 0, minWidth: 240 }}>
            <label className="form-label">Actor User ID</label>
            <input
              className="form-control mono"
              placeholder="UUID"
              value={actorUserId}
              onChange={(e) => setActorUserId(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-sm">Filter</button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => { setEntityType(''); setActorUserId(''); setPage(1); load(1); }}
          >
            Clear
          </button>
        </form>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Entity Type</th>
                  <th>Entity ID</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--c-text-muted)' }}>
                      No audit entries found.
                    </td>
                  </tr>
                ) : (
                  entries.map((entry) => (
                    <tr key={entry.id}>
                      <td style={{ fontSize: 12, color: 'var(--c-text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>{entry.actorUserId.slice(0, 8)}…</td>
                      <td>
                        <span className="badge badge-type-earned">{entry.entityType}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>{entry.entityId.slice(0, 8)}…</td>
                      <td>
                        <span className={`badge badge-${entry.action === 'deleted' ? 'disputed' : entry.action === 'created' ? 'approved' : 'pending'}`}>
                          {entry.action}
                        </span>
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
              <span style={{ fontSize: 13 }}>Page {page} of {totalPages} ({total} total)</span>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
