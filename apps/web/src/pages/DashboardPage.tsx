import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { getDashboard } from '../api';
import type { DashboardData } from '../types';

function fmt(val: string | number): string {
  const n = Number(val);
  if (isNaN(n)) return '$0';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

const STATUS_COLORS: Record<string, string> = {
  approved: '#22c55e',
  paid: '#3b82f6',
  pending: '#f59e0b',
  disputed: '#ef4444',
};

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await getDashboard();
      setData(d);
    } catch {
      setError('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const periodCards = data
    ? [
        { label: 'Month to Date', ...data.mtd },
        { label: 'Quarter to Date', ...data.qtd },
        { label: 'Year to Date', ...data.ytd },
      ]
    : [];

  const byStatusChartData = data
    ? Object.entries(data.by_status).map(([status, v]) => ({
        status,
        amount: Number(v.total),
        count: v.count,
      }))
    : [];

  if (loading) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">My Dashboard</h1>
        </div>
        <p style={{ color: 'var(--c-muted)' }}>Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">My Dashboard</h1>
        </div>
        <div className="alert alert-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">My Dashboard</h1>
        <button className="btn btn-sm" onClick={() => { void load(); }}>Refresh</button>
      </div>

      {/* Period cards */}
      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
        {periodCards.map((card) => (
          <div key={card.label} className="card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--c-muted)', marginBottom: 8 }}>{card.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--c-primary)' }}>
              {fmt(card.total)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--c-muted)', marginTop: 4 }}>
              {card.count} event{card.count !== 1 ? 's' : ''}
            </div>
          </div>
        ))}
      </div>

      {/* By-status chart */}
      {byStatusChartData.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <h2 className="card-title">Commission by Status</h2>
          </div>
          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byStatusChartData} margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
                <XAxis dataKey="status" tick={{ fontSize: 12, fill: 'var(--c-muted)' }} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--c-muted)' }} tickFormatter={(v: number) => fmt(v)} />
                <Tooltip
                  formatter={(value) => [fmt(String(value ?? 0)), 'Amount']}
                  contentStyle={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 8 }}
                />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                  {byStatusChartData.map((entry) => (
                    <Cell key={entry.status} fill={STATUS_COLORS[entry.status] ?? '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* By-status breakdown table */}
      {data && Object.keys(data.by_status).length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Breakdown by Status</h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Events</th>
                <th>Total Amount</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.by_status).map(([status, v]) => (
                <tr key={status}>
                  <td>
                    <span className={`badge badge-${status}`}>{status}</span>
                  </td>
                  <td>{v.count}</td>
                  <td>{fmt(v.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && Object.keys(data.by_status).length === 0 && (
        <div className="card">
          <p style={{ color: 'var(--c-muted)', textAlign: 'center', padding: 32 }}>
            No commission events yet. Events will appear here once you have approved commissions.
          </p>
        </div>
      )}
    </div>
  );
}
