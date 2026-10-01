import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router';
import { Activity, ArrowLeft, Globe, Inbox, LayoutDashboard, Mail, PlugZap, ScrollText, Server, Settings2, Ticket, Users, AtSign } from 'lucide-react';
import { useSession } from '../../lib/session';
import { LogoMark } from '../../components/Logo';
import { cx, IconButton } from '../../components/ui';
import { Overview } from './Overview';
import { UsersPage } from './Users';
import { DomainsPage, DomainDetail } from './Domains';
import { AddressesPage } from './Addresses';
import { ProvidersPage } from './Providers';
import { QueuePage, LogsPage } from './Queue';
import { InvitesPage } from './Invites';
import { AdminSettingsPage } from './AdminSettings';
import { AuditPage, SystemPage } from './System';

const NAV = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/domains', label: 'Domains', icon: Globe },
  { to: '/admin/addresses', label: 'Aliases & groups', icon: AtSign },
  { to: '/admin/providers', label: 'Providers', icon: PlugZap },
  { to: '/admin/queue', label: 'Mail queue', icon: Mail },
  { to: '/admin/logs', label: 'Delivery logs', icon: Activity },
  { to: '/admin/invites', label: 'Invites', icon: Ticket },
  { to: '/admin/settings', label: 'Settings & policies', icon: Settings2 },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
  { to: '/admin/system', label: 'System & backup', icon: Server },
];

export function AdminLayout() {
  const { instance } = useSession();
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-16 shrink-0 items-center gap-3 px-4">
        <IconButton label="Back to mail" onClick={() => navigate('/inbox')}>
          <ArrowLeft className="size-5" />
        </IconButton>
        <LogoMark className="size-9" />
        <div className="leading-tight">
          <div className="text-[17px] font-semibold tracking-tight">{instance.name}</div>
          <div className="text-xs text-muted">Admin panel</div>
        </div>
        <button onClick={() => navigate('/inbox')} className="ml-auto flex items-center gap-2 rounded-full px-4 py-2 text-sm text-muted hover:bg-hover hover:text-fg">
          <Inbox className="size-4" /> Open mail
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 overflow-y-auto pr-3 pb-6 max-lg:w-16">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              title={n.label}
              className={({ isActive }) =>
                cx(
                  'flex h-9 items-center gap-3 rounded-r-full pl-6 text-sm transition-colors max-lg:pl-5',
                  isActive ? 'bg-sel font-semibold' : 'text-fg hover:bg-hover',
                )
              }
            >
              <n.icon className="size-[18px] shrink-0" />
              <span className="truncate max-lg:hidden">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1 pr-4 pb-4">
          <div className="h-full overflow-y-auto rounded-2xl bg-panel2/40 shadow-[0_0_0_1px_var(--line)] dark:bg-panel/40">
            <div className="mx-auto max-w-6xl px-8 py-7 max-md:px-4">
              <Routes>
                <Route index element={<Overview />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="domains" element={<DomainsPage />} />
                <Route path="domains/:id" element={<DomainDetail />} />
                <Route path="addresses" element={<AddressesPage />} />
                <Route path="providers" element={<ProvidersPage />} />
                <Route path="queue" element={<QueuePage />} />
                <Route path="logs" element={<LogsPage />} />
                <Route path="invites" element={<InvitesPage />} />
                <Route path="settings/:tab?" element={<AdminSettingsPage />} />
                <Route path="audit" element={<AuditPage />} />
                <Route path="system" element={<SystemPage />} />
                <Route path="*" element={<Navigate to="/admin" replace />} />
              </Routes>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
