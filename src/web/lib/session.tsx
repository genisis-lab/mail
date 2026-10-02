import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Label, SessionUser, UserPrefs } from '../../shared/types';
import { api } from './api';

export interface Instance {
  name: string;
  accent: string;
  loginMessage: string;
  registration: 'closed' | 'invite' | 'open';
  registrationDomains: string[];
  setupComplete: boolean;
  version: string;
  retention: { trashDays: number; spamDays: number };
}

export interface MeResponse {
  user: SessionUser | null;
  mfaPending: boolean;
  instance: Instance;
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<MeResponse>('/api/auth/me'), staleTime: 60_000 });
}

interface SessionValue {
  user: SessionUser;
  instance: Instance;
  isAdmin: boolean;
  prefs: UserPrefs;
  refresh: () => Promise<unknown>;
}

const SessionCtx = createContext<SessionValue | null>(null);

export function SessionProvider({ value, children }: { value: Omit<SessionValue, 'refresh' | 'isAdmin' | 'prefs'>; children: ReactNode }) {
  const qc = useQueryClient();
  const v: SessionValue = {
    ...value,
    prefs: value.user.prefs,
    isAdmin: value.user.role === 'admin' || value.user.role === 'owner',
    refresh: () => qc.invalidateQueries({ queryKey: ['me'] }),
  };
  return <SessionCtx.Provider value={v}>{children}</SessionCtx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Apply theme + accent to <html>. */
export function useTheme(theme: UserPrefs['theme'] | undefined, accent: string | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || ((theme ?? 'system') === 'system' && mq.matches);
      root.classList.toggle('dark', dark);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) document.documentElement.style.setProperty('--accent', accent);
  }, [accent]);
}

export function useLabels() {
  return useQuery({ queryKey: ['labels'], queryFn: () => api.get<{ labels: Label[] }>('/api/labels').then((r) => r.labels), staleTime: 60_000 });
}

export interface Counters {
  inbox: number;
  spam: number;
  drafts: number;
  scheduled: number;
  snoozed: number;
  starred: number;
  important: number;
  /** Unread conversations per inbox tab. */
  categories?: { primary: number; updates: number; promotions: number };
  labels: { id: number; unread: number; total: number }[];
}

/** The Inbox count: Primary only when the inbox is split into tabs. */
export function inboxCount(c: Counters | undefined, tabs: boolean): number | undefined {
  if (!c) return undefined;
  return tabs && c.categories ? c.categories.primary : c.inbox;
}

export function useCounters() {
  return useQuery({ queryKey: ['counters'], queryFn: () => api.get<Counters>('/api/mail/counters'), refetchInterval: 30_000 });
}
