import { useState } from 'react';
import { useAuth, decodeToken } from '../auth';

async function fetchDevToken(role: 'admin' | 'rep'): Promise<string> {
  const res = await fetch('/dev/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json() as { token: string };
  return data.token;
}

export function SetupPage() {
  const { setToken } = useAuth();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ReturnType<typeof decodeToken>>(null);
  const [generating, setGenerating] = useState(false);

  function handleChange(v: string) {
    setValue(v);
    setError('');
    const decoded = decodeToken(v.trim());
    setPreview(decoded);
  }

  function handleSave() {
    if (!value.trim()) {
      setError('Paste a JWT token above.');
      return;
    }
    const ok = setToken(value.trim());
    if (!ok) {
      setError('Invalid JWT — could not decode payload. Make sure it is a valid signed token.');
    }
  }

  async function handleGenerate(role: 'admin' | 'rep') {
    setGenerating(true);
    setError('');
    try {
      const token = await fetchDevToken(role);
      handleChange(token);
    } catch {
      setError('Could not generate token — is the API running with JWT_SIGNING_KEY set?');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="setup-page">
      <div className="setup-card">
        <div className="setup-logo">☀️</div>
        <div className="setup-title">Sunscape Commissions</div>
        <div className="setup-sub">Enter your JWT to access the dashboard</div>

        <div className="form-group">
          <label className="form-label">Bearer Token</label>
          <textarea
            className="form-control"
            style={{ height: 100, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
            placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            spellCheck={false}
          />
          {error && <div className="form-error">{error}</div>}
        </div>

        {preview && (
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Token decoded ✓</div>
              <div>Org: <span className="mono">{preview.org_id}</span></div>
              <div>User: <span className="mono">{preview.user_id}</span></div>
              <div>Role: <span className="mono">{preview.role}</span></div>
              {preview.exp && (
                <div>Expires: {new Date(preview.exp * 1000).toLocaleString()}</div>
              )}
            </div>
          </div>
        )}

        <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleSave}>
          Continue to Dashboard
        </button>

        <hr className="divider" />

        <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Generate a dev token</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm"
              style={{ flex: 1 }}
              disabled={generating}
              onClick={() => { void handleGenerate('admin'); }}
            >
              {generating ? 'Generating…' : '⚡ Admin token'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              style={{ flex: 1 }}
              disabled={generating}
              onClick={() => { void handleGenerate('rep'); }}
            >
              {generating ? 'Generating…' : '⚡ Rep token'}
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-text-muted)' }}>
            Calls <span className="mono">POST /dev/token</span> — only works in development.
          </div>
        </div>
      </div>
    </div>
  );
}
