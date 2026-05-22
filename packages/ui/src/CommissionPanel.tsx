import { useState, useEffect } from 'react';

interface CommissionEvent {
  id: string;
  planId: string | null;
  eventType: string;
  amount: string;
  status: string;
  notes: string | null;
  createdAt: string;
}

interface EventsResponse {
  events: CommissionEvent[];
  total: number;
}

interface PlanRules {
  percent?: number;
  rate_per_watt?: number;
  [key: string]: unknown;
}

interface CommissionPlan {
  id: string;
  name: string;
  calculationType: string;
  rules: PlanRules;
  earnedTriggerStage: string;
}

interface PlansResponse {
  plans: CommissionPlan[];
  total: number;
}

interface CommissionPanelProps {
  /** Base URL of the Sunscape Commissions API (e.g. "https://commissions.example.com") */
  apiBaseUrl: string;
  /** Bearer token for authentication */
  token: string;
  /** The project UUID to display commissions for */
  projectId: string;
  /** Optional CSS class for the root element */
  className?: string;
  /** Optional inline style */
  style?: React.CSSProperties;
}

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  approved:  { bg: '#dcfce7', color: '#16a34a' },
  paid:      { bg: '#dbeafe', color: '#1d4ed8' },
  pending:   { bg: '#fef9c3', color: '#ca8a04' },
  disputed:  { bg: '#fee2e2', color: '#dc2626' },
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  earned:          'Earned',
  override_earned: 'Override',
  adjusted:        'Adjustment',
  clawed_back:     'Clawback',
  adder:           'Adder',
  deduction:       'Deduction',
};

function fmt(val: string): string {
  const n = Number(val);
  if (isNaN(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const baseStyle: React.CSSProperties = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 14,
  color: '#1e293b',
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 12,
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  background: '#0f172a',
  color: '#f8fafc',
  padding: '16px 20px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const bodyStyle: React.CSSProperties = {
  padding: '0',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 20px',
  borderBottom: '1px solid #f1f5f9',
};

function Badge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: '#f1f5f9', color: '#64748b' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        background: colors.bg,
        color: colors.color,
      }}
    >
      {status}
    </span>
  );
}

/**
 * CommissionPanel — embeddable component for displaying a rep's commission events
 * for a specific project. Designed for use inside Sunscape or other host apps.
 *
 * Usage:
 * ```tsx
 * <CommissionPanel
 *   apiBaseUrl="https://commissions.example.com"
 *   token={jwtToken}
 *   projectId={deal.id}
 * />
 * ```
 */
function describePlan(plan: CommissionPlan): string {
  const trigger = `earns at stage "${plan.earnedTriggerStage}"`;
  if (plan.calculationType === 'percent_contract') {
    const pct = plan.rules['percent'];
    return typeof pct === 'number' ? `${pct}% of contract value — ${trigger}` : trigger;
  }
  if (plan.calculationType === 'ppw') {
    const rate = plan.rules['rate_per_watt'];
    return typeof rate === 'number' ? `$${rate}/W — ${trigger}` : trigger;
  }
  if (plan.calculationType === 'tiered') return `Tiered rates — ${trigger}`;
  return `Hybrid plan — ${trigger}`;
}

export function CommissionPanel({
  apiBaseUrl,
  token,
  projectId,
  className,
  style,
}: CommissionPanelProps) {
  const [events, setEvents] = useState<CommissionEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [planSummary, setPlanSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !projectId) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPlanSummary(null);

    const base = apiBaseUrl.replace(/\/$/, '');
    const eventsUrl = `${base}/api/v1/events/me/events?project_id=${encodeURIComponent(projectId)}&limit=50`;

    fetch(eventsUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API error ${res.status}`);
        return res.json() as Promise<EventsResponse>;
      })
      .then(async (data) => {
        setEvents(data.events);
        setTotal(data.total);

        const planIds = [...new Set(data.events.map((e) => e.planId).filter((id): id is string => !!id))];
        if (planIds.length > 0) {
          try {
            const plansRes = await fetch(`${base}/api/v1/plans?page=1&limit=100`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: controller.signal,
            });
            if (plansRes.ok) {
              const plansData = await plansRes.json() as PlansResponse;
              const matchedPlan = plansData.plans.find((p) => planIds.includes(p.id));
              if (matchedPlan) {
                setPlanSummary(`${matchedPlan.name}: ${describePlan(matchedPlan)}`);
              }
            }
          } catch {
            // Non-critical — plan name is nice-to-have
          }
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError('Unable to load commission data');
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [apiBaseUrl, token, projectId]);

  const net = events.reduce((sum, ev) => {
    const amt = Number(ev.amount);
    if (ev.eventType === 'clawed_back' || ev.eventType === 'deduction') return sum - amt;
    return sum + amt;
  }, 0);

  const mergedStyle = { ...baseStyle, ...style };

  return (
    <div className={className} style={mergedStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontSize: 18 }}>☀️</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Commission Summary</div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 1 }}>
            {planSummary ?? `Project ${projectId.slice(0, 8)}…`}
          </div>
        </div>
        {!loading && !error && (
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#f97316' }}>{fmt(String(net))}</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>Net Payable</div>
          </div>
        )}
      </div>

      <div style={bodyStyle}>
        {loading && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: '#94a3b8' }}>
            Loading commissions…
          </div>
        )}

        {error && (
          <div style={{ padding: '16px 20px', color: '#dc2626', background: '#fee2e2', fontSize: 13 }}>
            {error}
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            No commission events for this project yet.
          </div>
        )}

        {!loading && !error && events.map((ev) => (
          <div key={ev.id} style={rowStyle}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {EVENT_TYPE_LABELS[ev.eventType] ?? ev.eventType}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                {new Date(ev.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {ev.notes && (
                  <span style={{ marginLeft: 8 }}>· {ev.notes.slice(0, 60)}{ev.notes.length > 60 ? '…' : ''}</span>
                )}
              </div>
            </div>
            <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <span style={{ fontWeight: 700, color: ev.eventType === 'clawed_back' ? '#dc2626' : '#1e293b' }}>
                {ev.eventType === 'clawed_back' ? '-' : ''}{fmt(ev.amount)}
              </span>
              <Badge status={ev.status} />
            </div>
          </div>
        ))}

        {!loading && !error && total > 50 && (
          <div style={{ padding: '10px 20px', textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>
            Showing 50 of {total} events
          </div>
        )}
      </div>
    </div>
  );
}
