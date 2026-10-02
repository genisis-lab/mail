import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { Activity, ArrowLeft, Globe, Inbox, LayoutDashboard, Mail, Menu as MenuIcon, PlugZap, ScrollText, Server, Settings2, Ticket, Users, AtSign } from 'lucide-react';
import { useSession } from '../../lib/session';
import { LogoMark } from '../../components/Logo';
import { cx, IconButton, useDialogFocus } from '../../components/ui';
import { Overview } from './Overview';
import { useAlerts } from './alerts';
import { UsersPage } from './Users';
import { UserDetailPage } from './UserDetail';
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

function AdminNav({ wide, alerts }: { wide: boolean; alerts: number }) {
  return (
    <>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          title={n.label}
          className={({ isActive }) =>
            cx(
              'flex h-9 items-center gap-3 rounded-r-full pl-6 text-sm transition-colors',
              !wide && 'max-lg:pl-5',
              isActive ? 'bg-sel font-semibold' : 'text-fg hover:bg-hover',
            )
          }
        >
          <span className="relative">
            <n.icon className="size-[18px] shrink-0" />
            {n.end && alerts > 0 && !wide && <span className="absolute -top-1 -right-1.5 size-2 rounded-full bg-danger lg:hidden" />}
          </span>
          <span className={cx('flex-1 truncate', !wide && 'max-lg:hidden')}>{n.label}</span>
          {n.end && alerts > 0 && (
            <span className={cx('mr-3 rounded-full bg-danger px-1.5 text-[11px] leading-[18px] font-semibold text-white', !wide && 'max-lg:hidden')} aria-label={`${alerts} open alert${alerts === 1 ? '' : 's'}`}>
              {alerts}
            </span>
          )}
        </NavLink>
      ))}
    </>
  );
}

export function AdminLayout() {
  const { instance } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const alerts = useAlerts();
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  useDialogFocus(drawer, drawerRef, () => setDrawer(false));
  useEffect(() => setDrawer(false), [location.pathname]);
  const open = alerts.data?.open.length ?? 0;
  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-16 shrink-0 items-center gap-3 px-4 max-md:h-14 max-md:gap-2 max-md:px-2">
        <IconButton label="Admin menu" onClick={() => setDrawer(true)} className="md:hidden" aria-expanded={drawer}>
          <MenuIcon className="size-5" />
        </IconButton>
        <IconButton label="Back to mail" onClick={() => navigate('/inbox')} className="max-md:hidden">
          <ArrowLeft className="size-5" />
        </IconButton>
        <LogoMark className="size-9 max-md:size-8" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[17px] font-semibold tracking-tight">{instance.name}</div>
          <div className="text-xs text-muted">Admin panel</div>
        </div>
        <button onClick={() => navigate('/inbox')} className="ml-auto flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm text-muted hover:bg-hover hover:text-fg">
          <Inbox className="size-4" /> <span className="max-sm:hidden">Open mail</span>
          <span className="sr-only sm:hidden">Open mail</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Admin" className="w-60 shrink-0 overflow-y-auto pr-3 pb-6 max-lg:w-16 max-md:hidden">
          <AdminNav wide={false} alerts={open} />
        </nav>
        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden" onClick={() => setDrawer(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Admin menu"
              tabIndex={-1}
              className="animate-slide-up absolute top-0 bottom-0 left-0 w-64 overflow-y-auto bg-bg pt-3 pr-3 pb-6 shadow-float outline-none"
              onClick={(e) => e.stopPropagation()}
            >
              <nav aria-label="Admin">
                <AdminNav wide alerts={open} />
              </nav>
            </div>
          </div>
        )}
        <main className="min-w-0 flex-1 pr-4 pb-4 max-md:px-2 max-md:pb-2">
          <div className="h-full overflow-y-auto rounded-2xl bg-panel2/40 shadow-[0_0_0_1px_var(--line)] dark:bg-panel/40">
            <div className="mx-auto max-w-6xl px-8 py-7 max-md:px-4 max-md:py-5">
              <Routes>
                <Route index element={<Overview />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="users/:id" element={<UserDetailPage />} />
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
