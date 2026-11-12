import { insert, now } from '../db/index.js';

export function audit(userId: number | null, action: string, target = '', details?: unknown, ip?: string | null) {
  insert('INSERT INTO audit_log (user_id, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    userId,
    action,
    target,
    details === undefined ? null : JSON.stringify(details),
    ip ?? null,
    now(),
  ]);
}

/** An admin action's details, marked when it came from a native app's unlock (services/admin-unlock.ts). */
export function withVia(c: { get(key: 'via'): 'app' | undefined }, details?: unknown): unknown {
  const via = c.get('via');
  if (!via) return details;
  if (details === undefined || details === null) return { via };
  return typeof details === 'object' && !Array.isArray(details) ? { ...details, via } : { value: details, via };
}
