import { useState, useEffect, useCallback } from 'react';
import { listProjects, simulateTransition } from '../api';
import { useAuth } from '../auth';
import type { ProjectConfig } from '../types';

function SimulateTransitionModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (result: { events_created: number; events_already_existed: number }) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [fromStage, setFromStage] = useState('');
  const [toStage, setToStage] = useState('');
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 16));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!projectId || !fromStage || !toStage) {
      setError('All fields are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const transPayload: Parameters<typeof simulateTransition>[0] = {
        project_id: projectId,
        from_stage: fromStage,
        to_stage: toStage,
        transition_id: crypto.randomUUID(),
      };
      if (occurredAt) transPayload.occurred_at = new Date(occurredAt).toISOString();
      const result = await simulateTransition(transPayload);
      onDone(result);
    } catch (err: unknown) {
      const body = err instanceof Error ? err.message : 'Transition failed';
      setError(String(body));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Simulate Stage Transition</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--c-muted)', marginBottom: 16, fontSize: 13 }}>
            Triggers the commission engine with a synthetic stage transition. A new transition ID is generated automatically.
          </p>
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

          <div className="form-group">
            <label className="form-label">Project ID *</label>
            <input className="form-control" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="UUID of the project" />
          </div>

          <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">From Stage *</label>
              <input className="form-control" value={fromStage} onChange={(e) => setFromStage(e.target.value)} placeholder="e.g. permit" />
            </div>
            <div className="form-group">
              <label className="form-label">To Stage *</label>
              <input className="form-control" value={toStage} onChange={(e) => setToStage(e.target.value)} placeholder="e.g. install" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Occurred At</label>
            <input type="datetime-local" className="form-control" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => { void submit(); }} disabled={loading}>
            {loading ? 'Simulating…' : 'Simulate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TransitionResultModal({
  result,
  onClose,
}: {
  result: { events_created: number; events_already_existed: number; event_ids: string[] };
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Transition Result</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="card-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 16 }}>
            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--c-primary)' }}>{result.events_created}</div>
              <div style={{ fontSize: 13, color: 'var(--c-muted)' }}>Events Created</div>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--c-muted)' }}>{result.events_already_existed}</div>
              <div style={{ fontSize: 13, color: 'var(--c-muted)' }}>Already Existed</div>
            </div>
          </div>
          {result.event_ids.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 4 }}>Event IDs:</div>
              {result.event_ids.map((id) => (
                <div key={id} style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--c-muted)' }}>{id}</div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const { isAdmin } = useAuth();
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSimulate, setShowSimulate] = useState(false);
  const [transitionResult, setTransitionResult] = useState<{
    events_created: number;
    events_already_existed: number;
    event_ids: string[];
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listProjects();
      setProjects(resp.projects);
      setTotal(resp.total);
    } catch {
      setError('Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page">
      {showSimulate && (
        <SimulateTransitionModal
          onClose={() => setShowSimulate(false)}
          onDone={(result) => {
            setShowSimulate(false);
            setTransitionResult({ ...result, event_ids: [] });
          }}
        />
      )}
      {transitionResult && (
        <TransitionResultModal
          result={transitionResult}
          onClose={() => { setTransitionResult(null); void load(); }}
        />
      )}

      <div className="page-header">
        <h1 className="page-title">Projects <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--c-muted)' }}>({total})</span></h1>
        {isAdmin && (
          <button className="btn" onClick={() => setShowSimulate(true)}>▶ Simulate Transition</button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Project ID</th>
              <th>Reps</th>
              <th>Contract Value</th>
              <th>System Size</th>
              <th>Plan Override</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>Loading…</td></tr>
            )}
            {!loading && projects.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--c-muted)' }}>
                No projects configured. Use the Sunscape integration to register projects.
              </td></tr>
            )}
            {projects.map((p) => (
              <tr key={p.id}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.projectId.slice(0, 16)}…</td>
                <td style={{ fontSize: 12 }}>
                  {p.repAssignments.map((r) => (
                    <div key={r.user_id}>
                      <span className="badge" style={{ marginRight: 4 }}>{r.role}</span>
                      {r.user_id.slice(0, 8)}… ({r.split_percent}%)
                    </div>
                  ))}
                </td>
                <td>${Number(p.contractValue).toLocaleString()}</td>
                <td>{p.systemSizeKw} kW</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--c-muted)' }}>
                  {p.planOverrideId ? p.planOverrideId.slice(0, 8) + '…' : '—'}
                </td>
                <td style={{ fontSize: 12, color: 'var(--c-muted)' }}>
                  {new Date(p.updatedAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
