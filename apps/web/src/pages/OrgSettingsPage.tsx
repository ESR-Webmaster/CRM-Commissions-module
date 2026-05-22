import { useState, useEffect, useCallback } from 'react';
import { getOrgSettings, patchOrgSettings, ApiError } from '../api';
import { useAuth } from '../auth';
import type { OrgSettings } from '../types';

export function OrgSettingsPage() {
  const { isAdmin } = useAuth();
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await getOrgSettings();
      setSettings(s);
    } catch (e) {
      setError(e instanceof ApiError ? `Error ${e.status} loading settings` : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleToggle(value: boolean) {
    if (!isAdmin) return;
    setSaving(true);
    setError('');
    try {
      const updated = await patchOrgSettings({ require_event_approval: value });
      setSettings(updated);
      setToast('Settings saved');
      setTimeout(() => setToast(''), 3000);
    } catch (e) {
      setError(e instanceof ApiError ? `Error ${e.status} saving settings` : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Organisation Settings</div>
          <div className="page-subtitle">Configure commission workflow behaviour for your org</div>
        </div>
      </div>

      <div className="page-content">
        {error && (
          <div className="alert alert-error">⚠️ {error}</div>
        )}

        {loading ? (
          <div className="loading-center">
            <div className="spinner" /> Loading settings…
          </div>
        ) : settings ? (
          <div className="card" style={{ maxWidth: 560 }}>
            <div className="card-header">
              <div className="card-title">Commission Workflow</div>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Require event approval</div>
                  <div style={{ fontSize: 13, color: 'var(--c-text-muted)', maxWidth: 340 }}>
                    When enabled, all commission events must be explicitly approved before they
                    become payable. When disabled, events are auto-approved on creation.
                  </div>
                  {!isAdmin && (
                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginTop: 8 }}>
                      Admin role required to change this setting.
                    </div>
                  )}
                </div>
                <label className="toggle" style={{ marginTop: 2 }}>
                  <input
                    type="checkbox"
                    checked={settings.requireEventApproval}
                    disabled={!isAdmin || saving}
                    onChange={(e) => { void handleToggle(e.target.checked); }}
                  />
                  <span className="toggle-track" />
                </label>
              </div>

              <hr className="divider" />

              <div className="kv-list">
                <div className="kv-item">
                  <div className="kv-key">Current value</div>
                  <div className="kv-val">
                    {settings.requireEventApproval
                      ? <span className="badge badge-orange">Approval required</span>
                      : <span className="badge badge-green">Auto-approve</span>}
                  </div>
                </div>
                <div className="kv-item">
                  <div className="kv-key">Your role</div>
                  <div className="kv-val">
                    <span className={`badge ${isAdmin ? 'badge-blue' : 'badge-gray'}`}>
                      {isAdmin ? 'Admin' : 'Rep (read-only)'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {toast && (
          <div className="toast-container">
            <div className="toast toast-success">✓ {toast}</div>
          </div>
        )}
      </div>
    </>
  );
}
