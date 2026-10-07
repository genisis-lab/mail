/**
 * Sending while offline: the message waits on this device and goes out as soon
 * as the connection is back (next time Wren is open). Attachments must already
 * be uploaded, which needs a connection anyway.
 */
import { ApiError, apiFor } from './api';

const KEY = 'wren:outbox';

export interface QueuedSend {
  id: string;
  /** Who wrote it: only sent while that person is signed in on this device. */
  userId: number;
  mailbox: number | null;
  subject: string;
  payload: Record<string, unknown>;
  queuedAt: number;
}

function read(): QueuedSend[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as QueuedSend[];
  } catch {
    return [];
  }
}

function write(list: QueuedSend[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage full or blocked: nothing more we can do here */
  }
  window.dispatchEvent(new CustomEvent('wren:outbox'));
}

export function queuedSends(): QueuedSend[] {
  return read();
}

/** A failed request that never reached the server (offline, connection dropped). */
export function isNetworkError(err: unknown): boolean {
  return !(err instanceof ApiError) && (err instanceof TypeError || !navigator.onLine);
}

export function queueSend(item: Omit<QueuedSend, 'id' | 'queuedAt'>) {
  write([...read(), { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, queuedAt: Date.now() }]);
}

/** Forget everything waiting (signing out on this device). */
export function clearOutbox() {
  write([]);
}

let flushing = false;

/**
 * Try to send everything waiting. A message the server refuses (say, a bad
 * address) is kept as a draft instead, so nothing is lost.
 */
export async function flushOutbox(userId: number, notify: (msg: string, error?: boolean) => void): Promise<void> {
  if (flushing || !navigator.onLine) return;
  const list = read().filter((q) => q.userId === userId);
  if (!list.length) return;
  flushing = true;
  try {
    for (const item of list) {
      const api = apiFor(item.mailbox);
      try {
        await api.post('/api/compose/send', item.payload);
        write(read().filter((q) => q.id !== item.id));
        notify(`Sent “${item.subject || '(no subject)'}”`);
      } catch (err) {
        if (isNetworkError(err)) return; // still offline: try again later
        if (err instanceof ApiError && err.status === 401) return; // signed out: keep it until they sign in
        const { sendAt: _s, draftId, ...draft } = item.payload as { sendAt?: unknown; draftId?: number | null };
        try {
          if (draftId) await api.put(`/api/compose/drafts/${draftId}`, draft);
          else await api.post('/api/compose/drafts', draft);
        } catch {
          /* the message stays queued for another try */
          return;
        }
        write(read().filter((q) => q.id !== item.id));
        notify(`Couldn’t send “${item.subject || '(no subject)'}”: ${(err as Error).message}. It’s in Drafts.`, true);
      }
    }
  } finally {
    flushing = false;
  }
}
