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
