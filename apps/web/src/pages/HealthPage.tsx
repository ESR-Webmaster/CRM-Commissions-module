import { useState, useEffect, useCallback } from 'react';
import { getHealth, getHealthReady, getHealthVersion } from '../api';
import type { HealthStatus, HealthReady, HealthVersion } from '../types';

type Status = 'loading' | 'ok' | 'error';

interface HealthState {
  liveness: { status: Status };
  readiness: { status: Status; data: HealthReady | undefined };
  version: { status: Status; data: HealthVersion | undefined };
  lastChecked: Date | null;
}

export function HealthPage() {
  const [state, setState] = useState<HealthState>({
    liveness: { status: 'loading' },
    readiness: { status: 'loading', data: undefined },
    version: { status: 'loading', data: undefined },
    lastChecked: null,
  });
  const [refreshing, setRefreshing] = useState(false);

  const check = useCallback(async () => {
    setRefreshing(true);

    const [liveness, readiness, version] = await Promise.allSettled([
      getHealth(),
      getHealthReady(),
      getHealthVersion(),
    ]);

    setState({
      liveness: {
        status: liveness.status === 'fulfilled'
          ? (liveness.value as HealthStatus).status === 'ok' ? 'ok' : 'error'
          : 'error',
      },
      readiness: {
        status: readiness.status === 'fulfilled'
          ? (readiness.value as HealthReady).status === 'ok' ? 'ok' : 'error'
          : 'error',
        data: readiness.status === 'fulfilled' ? readiness.value as HealthReady : undefined,
      },
      version: {
        status: version.status === 'fulfilled' ? 'ok' : 'error',
        data: version.status === 'fulfilled' ? version.value as HealthVersion : undefined,
      },
      lastChecked: new Date(),
    });
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => { void check(); }, 15_000);
    return () => clearInterval(timer);
  }, [check]);

  function dotClass(s: Status) {
    if (s === 'loading') return 'health-dot health-dot-gray';
    if (s === 'ok') return 'health-dot health-dot-green';
    return 'health-dot health-dot-red';
  }

  function label(s: Status) {
    if (s === 'loading') return 'Checking…';
    if (s === 'ok') return 'Healthy';
    return 'Unreachable';
  }

  const { liveness, readiness, version } = state;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">System Health</div>
          <div className="page-subtitle">
            Live status — auto-refreshes every 15 s
            {state.lastChecked && (
              <span> · Last checked {state.lastChecked.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => { void check(); }}
          disabled={refreshing}
        >
          {refreshing ? <span className="spinner" style={{ width: 14, height: 14 }} /> : '↺'} Refresh
        </button>
      </div>

      <div className="page-content">
        <div className="health-grid">
          <div className="health-card">
            <div className={dotClass(liveness.status)} />
            <div>
              <div className="health-card-label">Liveness</div>
              <div className="health-card-value">{label(liveness.status)}</div>
              <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 2 }}>
                GET /health
              </div>
            </div>
          </div>

          <div className="health-card">
            <div className={dotClass(readiness.status)} />
            <div>
              <div className="health-card-label">Readiness</div>
              <div className="health-card-value">{label(readiness.status)}</div>
              <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 2 }}>
                GET /health/ready · DB + migrations
              </div>
            </div>
          </div>

          <div className="health-card">
            <div className={dotClass(version.status)} />
            <div>
              <div className="health-card-label">Version</div>
              <div className="health-card-value">
                {version.data ? `v${version.data.version}` : label(version.status)}
              </div>
              {version.data?.buildSha && (
                <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 2 }}>
                  Build: <span className="mono">{version.data.buildSha.slice(0, 8)}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {readiness.data && readiness.status === 'ok' && (
          <div className="card" style={{ marginTop: 8 }}>
            <div className="card-header">
              <div className="card-title">Database Details</div>
            </div>
            <div className="card-body">
              <div className="kv-list">
                {readiness.data.migrationHash && (
                  <div className="kv-item">
                    <div className="kv-key">Migration Hash</div>
                    <div className="kv-val">
                      <span className="mono">{readiness.data.migrationHash.slice(0, 16)}…</span>
                    </div>
                  </div>
                )}
                <div className="kv-item">
                  <div className="kv-key">Readiness</div>
                  <div className="kv-val">
                    <span className="badge badge-green">✓ OK</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {(liveness.status === 'error' || readiness.status === 'error') && (
          <div className="alert alert-warning">
            ⚠️ API server unreachable. Make sure the API is running on port 3001 and
            the Vite proxy is configured correctly.
          </div>
        )}
      </div>
    </>
  );
}
