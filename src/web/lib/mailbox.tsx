/**
 * Which mailbox the mail views show: the person's own, or a shared mailbox
 * they belong to. Switching points the API client at it and drops cached mail.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api, setApiMailbox } from './api';

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

const KEY = 'wren.mailbox';
/** Cached queries whose content depends on the mailbox. */
const MAIL_QUERIES = new Set(['threads', 'thread', 'counters', 'labels']);

const Ctx = createContext<MailboxValue>({ current: null, mailboxes: [], switchTo: () => {} });

function stored(): number | null {
  try {
    return Number(sessionStorage.getItem(KEY)) || null;
  } catch {
    return null;
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
  const list = useMailboxes();
  const [id, setId] = useState<number | null>(stored);
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
        if (next) sessionStorage.setItem(KEY, String(next));
        else sessionStorage.removeItem(KEY);
      } catch {
        /* private mode */
      }
      navigate('/inbox');
    },
    [id, qc, navigate],
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
