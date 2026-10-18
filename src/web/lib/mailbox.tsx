/**
 * Which mailbox the mail views show: the person's own, or a shared mailbox
 * they belong to. Switching points the API client at it and drops cached mail.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api, setApiMailbox } from './api';
import { useSession } from './session';

export interface SharedMailbox {
  id: number;
  address: string;
  name: string;
  canSend: boolean;
  unread: number;
}

interface MailboxValue {
  /** The shared mailbox being viewed, or null for the person's own. */
  current: SharedMailbox | null;
  mailboxes: SharedMailbox[];
  switchTo: (id: number | null) => void;
}

/** Remembered per tab and account (a tab can switch to another account signed in on this browser). */
const KEY = 'wren.mailbox';
const keyFor = (account: number) => `${KEY}.${account}`;
/** Cached queries whose content depends on the mailbox. */
const MAIL_QUERIES = new Set(['threads', 'thread', 'counters', 'labels']);

const Ctx = createContext<MailboxValue>({ current: null, mailboxes: [], switchTo: () => {} });

function stored(account: number): number | null {
  try {
    return Number(sessionStorage.getItem(keyFor(account))) || null;
  } catch {
    return null;
  }
}

/** Forget which mailbox an account was looking at (signing out; no account: all of them). */
export function forgetMailbox(account?: number) {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && (account === undefined ? k === KEY || k.startsWith(`${KEY}.`) : k === keyFor(account))) sessionStorage.removeItem(k);
    }
  } catch {
    /* private mode */
  }
}

export function useMailboxes() {
  return useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: SharedMailbox[] }>('/api/account/mailboxes').then((r) => r.mailboxes),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function MailboxProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useSession();
  const list = useMailboxes();
  const [id, setId] = useState<number | null>(() => stored(user.id));
  // Set before children render, so their first requests already go to the right mailbox.
  setApiMailbox(id);

  const switchTo = useCallback(
    (next: number | null) => {
      if (next === id) return;
      void qc.cancelQueries({ predicate: (q) => MAIL_QUERIES.has(String(q.queryKey[0])) });
      setApiMailbox(next);
      qc.removeQueries({ predicate: (q) => MAIL_QUERIES.has(String(q.queryKey[0])) });
      setId(next);
      try {
        if (next) sessionStorage.setItem(keyFor(user.id), String(next));
        else sessionStorage.removeItem(keyFor(user.id));
      } catch {
        /* private mode */
      }
      navigate('/inbox');
    },
    [id, qc, navigate, user.id],
  );

  // Removed from a shared mailbox (or it was deleted): go back to their own.
  useEffect(() => {
    if (id && list.data && !list.data.some((b) => b.id === id)) switchTo(null);
  }, [id, list.data, switchTo]);

  const value = useMemo(() => ({ current: list.data?.find((b) => b.id === id) ?? null, mailboxes: list.data ?? [], switchTo }), [list.data, id, switchTo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMailbox() {
  return useContext(Ctx);
}
