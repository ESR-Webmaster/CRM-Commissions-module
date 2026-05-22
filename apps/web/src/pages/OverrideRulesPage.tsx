import { useEffect, useState } from 'react';
import { listOverrideRules, createOverrideRule, deleteOverrideRule } from '../api';
import type { OverrideRule } from '../types';

export function OverrideRulesPage() {
  const [rules, setRules] = useState<OverrideRule[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [managerUserId, setManagerUserId] = useState('');
  const [teamMemberIds, setTeamMemberIds] = useState('');
  const [overridePercent, setOverridePercent] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');

  function load() {
    setLoading(true);
    setError('');
    listOverrideRules()
      .then((r) => { setRules(r.rules); setTotal(r.total); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load rules'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const pct = parseFloat(overridePercent);
    if (!managerUserId.trim() || !teamMemberIds.trim() || isNaN(pct) || !effectiveFrom) {
      setFormError('Manager ID, team member IDs, percent, and effective from are required.');
      return;
    }
    const memberIds = teamMemberIds.split(',').map((s) => s.trim()).filter(Boolean);
    if (memberIds.length === 0) {
      setFormError('At least one team member ID is required.');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      const data: Parameters<typeof createOverrideRule>[0] = {
        manager_user_id: managerUserId.trim(),
        team_member_user_ids: memberIds,
        override_percent: pct,
        effective_from: new Date(effectiveFrom).toISOString(),
      };
      if (effectiveTo) data.effective_to = new Date(effectiveTo).toISOString();
      await createOverrideRule(data);
      setManagerUserId(''); setTeamMemberIds(''); setOverridePercent(''); setEffectiveFrom(''); setEffectiveTo('');
      setShowForm(false);
      load();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to create rule');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this override rule?')) return;
    try {
      await deleteOverrideRule(id);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to delete rule');
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Override Rules</div>
          <div className="page-sub">{total} rules configured</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ New Rule'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Create Override Rule</div>
          {formError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{formError}</div>}
          <form onSubmit={(e) => { void handleCreate(e); }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Manager User ID</label>
                <input className="form-control mono" value={managerUserId} onChange={(e) => setManagerUserId(e.target.value)} placeholder="UUID" required />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Override % (0–100)</label>
                <input className="form-control" type="number" step="0.01" min="0" max="100" value={overridePercent} onChange={(e) => setOverridePercent(e.target.value)} required />
              </div>
              <div className="form-group" style={{ margin: 0, gridColumn: '1 / -1' }}>
                <label className="form-label">Team Member IDs (comma-separated UUIDs)</label>
                <textarea className="form-control mono" rows={2} value={teamMemberIds} onChange={(e) => setTeamMemberIds(e.target.value)} placeholder="uuid1, uuid2, ..." required />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Effective From</label>
                <input className="form-control" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Effective To (optional)</label>
                <input className="form-control" type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Create Rule'}
            </button>
          </form>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Manager</th>
                <th>Override %</th>
                <th>Team Members</th>
                <th>Effective From</th>
                <th>Effective To</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--c-text-muted)' }}>
                    No override rules configured.
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ fontSize: 11 }}>{r.managerUserId.slice(0, 8)}…</td>
                    <td style={{ fontWeight: 600 }}>{r.overridePercent}%</td>
                    <td style={{ fontSize: 12 }}>
                      {r.teamMemberUserIds.length} member{r.teamMemberUserIds.length !== 1 ? 's' : ''}
                    </td>
                    <td style={{ fontSize: 12 }}>{new Date(r.effectiveFrom).toLocaleDateString()}</td>
                    <td style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
                      {r.effectiveTo ? new Date(r.effectiveTo).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <button
                        className="btn btn-xs"
                        style={{ color: 'var(--c-danger)' }}
                        onClick={() => { void handleDelete(r.id); }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
