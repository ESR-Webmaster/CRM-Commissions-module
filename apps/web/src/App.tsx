import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth';
import { setApiToken } from './api';
import { SetupPage } from './pages/SetupPage';
import { DashboardPage } from './pages/DashboardPage';
import { PlansPage } from './pages/PlansPage';
import { EventsPage } from './pages/EventsPage';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { StatementsPage } from './pages/StatementsPage';
import { UsersPage } from './pages/UsersPage';
import { AuditPage } from './pages/AuditPage';
import { AdjustmentsPage } from './pages/AdjustmentsPage';
import { OverrideRulesPage } from './pages/OverrideRulesPage';
import { OrgSettingsPage } from './pages/OrgSettingsPage';
import { HealthPage } from './pages/HealthPage';
import type { Page } from './types';

type NavItem = { id: Page; icon: string; label: string; adminOnly?: boolean; repOnly?: boolean };

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', icon: '📊', label: 'Dashboard' },
  { id: 'events', icon: '⚡', label: 'Commission Events' },
  { id: 'assignments', icon: '👥', label: 'Plan Assignments' },
  { id: 'projects', icon: '🏗️', label: 'Projects', adminOnly: true },
  { id: 'statements', icon: '📄', label: 'Payout Statements' },
  { id: 'plans', icon: '📋', label: 'Commission Plans', adminOnly: true },
  { id: 'adjustments', icon: '🔧', label: 'Adjustments', adminOnly: true },
  { id: 'override-rules', icon: '↗️', label: 'Override Rules', adminOnly: true },
  { id: 'users', icon: '👤', label: 'Users', adminOnly: true },
  { id: 'audit', icon: '🔍', label: 'Audit Log', adminOnly: true },
  { id: 'org-settings', icon: '⚙️', label: 'Org Settings', adminOnly: true },
  { id: 'health', icon: '💚', label: 'System Health', adminOnly: true },
];

function AppShell() {
  const { token, decoded, clearToken, isAdmin } = useAuth();
  const [page, setPage] = useState<Page>('dashboard');

  useEffect(() => {
    setApiToken(token);
  }, [token]);

  if (!token || !decoded) {
    return <SetupPage />;
  }

  const visibleNav = NAV_ITEMS.filter((item) => {
    if (item.adminOnly && !isAdmin) return false;
    if (item.repOnly && isAdmin) return false;
    return true;
  });

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">☀️</div>
          <div className="sidebar-brand-name">Sunscape Commissions</div>
          <div className="sidebar-brand-sub">Commission Engine</div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">Navigation</div>
          {visibleNav.map((item) => (
            <button
              key={item.id}
              className={`sidebar-item${page === item.id ? ' active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-token-info">
            <div className="sidebar-token-role">
              {decoded.role.toUpperCase()} · {decoded.org_id.slice(0, 8)}…
            </div>
            <div className="sidebar-token-id">{decoded.user_id.slice(0, 12)}…</div>
          </div>
          <button className="sidebar-item" onClick={clearToken} style={{ marginTop: 4 }}>
            <span className="icon">🚪</span>
            Sign out
          </button>
        </div>
      </nav>

      <main className="main">
        {page === 'dashboard' && <DashboardPage />}
        {page === 'plans' && <PlansPage />}
        {page === 'events' && <EventsPage />}
        {page === 'assignments' && <AssignmentsPage />}
        {page === 'projects' && <ProjectsPage />}
        {page === 'statements' && <StatementsPage />}
        {page === 'users' && <UsersPage />}
        {page === 'audit' && <AuditPage />}
        {page === 'adjustments' && <AdjustmentsPage />}
        {page === 'override-rules' && <OverrideRulesPage />}
        {page === 'org-settings' && <OrgSettingsPage />}
        {page === 'health' && <HealthPage />}
      </main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
