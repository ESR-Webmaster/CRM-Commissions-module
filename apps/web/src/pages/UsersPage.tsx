import { useEffect, useState } from 'react';
import { listUsers } from '../api';
import type { OrgUser } from '../types';

export function UsersPage() {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    listUsers()
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load users'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Users</div>
          <div className="page-sub">{users.length} members synced to this org</div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last Updated</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--c-text-muted)' }}>
                    No users synced. Use POST /api/v1/users/sync to import users.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 500 }}>{u.name}</td>
                    <td className="mono" style={{ fontSize: 13 }}>{u.email}</td>
                    <td>
                      <span className={`badge badge-${u.role === 'admin' ? 'approved' : 'pending'}`}>
                        {u.role}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
                      {new Date(u.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>
                      {u.id.slice(0, 8)}…
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
