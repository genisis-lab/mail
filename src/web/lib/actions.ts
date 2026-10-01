import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useToast } from '../components/toast';
import { plural } from './format';

export type ThreadActionType =
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  | 'important'
  | 'unimportant'
  | 'archive'
  | 'inbox'
  | 'trash'
  | 'untrash'
  | 'spam'
  | 'notspam'
  | 'delete'
  | 'unsnooze';

export type ThreadAction = { type: ThreadActionType } | { type: 'snooze'; until: number } | { type: 'label' | 'unlabel'; labelId: number };

const INVERSE: Partial<Record<string, ThreadActionType | 'unlabel' | 'label'>> = {
  archive: 'inbox',
  inbox: 'archive',
  trash: 'untrash',
  untrash: 'trash',
  spam: 'notspam',
  notspam: 'spam',
  snooze: 'unsnooze',
  read: 'unread',
  unread: 'read',
};

const MESSAGES: Partial<Record<string, (n: number) => string>> = {
  archive: (n) => `${plural(n, 'conversation')} archived`,
  inbox: (n) => `${plural(n, 'conversation')} moved to Inbox`,
  trash: (n) => `${plural(n, 'conversation')} moved to Trash`,
  untrash: (n) => `${plural(n, 'conversation')} restored`,
  spam: (n) => `${plural(n, 'conversation')} marked as spam`,
  notspam: (n) => `${plural(n, 'conversation')} moved to Inbox`,
  delete: (n) => `${plural(n, 'conversation')} deleted forever`,
  snooze: (n) => `${plural(n, 'conversation')} snoozed`,
  unsnooze: (n) => `${plural(n, 'conversation')} unsnoozed`,
  read: (n) => `${plural(n, 'conversation')} marked as read`,
  unread: (n) => `${plural(n, 'conversation')} marked as unread`,
};

/** Run a thread action with cache refresh and an Undo toast where it makes sense. */
export function useThreadActions() {
  const qc = useQueryClient();
  const toast = useToast();

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['threads'] });
    qc.invalidateQueries({ queryKey: ['thread'] });
    qc.invalidateQueries({ queryKey: ['counters'] });
  }, [qc]);

  const run = useCallback(
    async (threadIds: number[], action: ThreadAction, opts: { quiet?: boolean } = {}) => {
      if (!threadIds.length) return;
      try {
        await api.post('/api/mail/threads/actions', { threadIds, action });
        refresh();
        if (opts.quiet) return;
        const msg = MESSAGES[action.type]?.(threadIds.length);
        if (!msg) return;
        const inverse = INVERSE[action.type];
        toast({
          message: msg,
          action: inverse
            ? {
                label: 'Undo',
                onClick: async () => {
                  await api.post('/api/mail/threads/actions', { threadIds, action: { type: inverse } });
                  refresh();
                  toast('Action undone');
                },
              }
            : undefined,
        });
      } catch (err) {
        toast({ message: (err as Error).message, tone: 'error' });
      }
    },
    [refresh, toast],
  );

  return { run, refresh };
}

export function snoozeOptions(): { label: string; at: number; hint: string }[] {
  const now = new Date();
  const fmt = (d: Date) => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const laterToday = new Date(now);
  laterToday.setHours(now.getHours() + 3, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const weekend = new Date(now);
  weekend.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7));
  weekend.setHours(8, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + ((1 - now.getDay() + 7) % 7 || 7));
  nextWeek.setHours(8, 0, 0, 0);
  const opts = [
    { label: 'Later today', at: laterToday.getTime(), hint: fmt(laterToday) },
    { label: 'Tomorrow', at: tomorrow.getTime(), hint: fmt(tomorrow) },
    { label: 'This weekend', at: weekend.getTime(), hint: fmt(weekend) },
    { label: 'Next week', at: nextWeek.getTime(), hint: fmt(nextWeek) },
  ];
  return laterToday.getDate() !== now.getDate() || now.getHours() >= 18 ? opts.slice(1) : opts;
}
