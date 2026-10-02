/** Addresses Wren no longer mails: they hard-bounced, reported spam, or an admin blocked them. */
import { all, get, now, run } from '../db/index.js';
import { normalizeEmail } from '../lib/addr.js';

export interface Suppression {
  address: string;
  reason: 'bounce' | 'complaint' | 'manual';
  detail: string;
  createdAt: number;
}

export function suppressionFor(address: string): Suppression | null {
  const r = get<any>('SELECT * FROM suppressions WHERE address = ?', [normalizeEmail(address)]);
  return r ? { address: r.address, reason: r.reason, detail: r.detail, createdAt: r.created_at } : null;
}

export function suppress(address: string, reason: Suppression['reason'], detail: string, providerId: number | null = null) {
  run(
    `INSERT INTO suppressions (address, reason, detail, provider_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, provider_id = excluded.provider_id`,
    [normalizeEmail(address), reason, detail.slice(0, 500), providerId, now()],
  );
}

export function unsuppress(address: string): boolean {
  return run('DELETE FROM suppressions WHERE address = ?', [normalizeEmail(address)]).changes > 0;
}

/** Why a suppressed recipient isn't mailed, in words for the sender. */
export function suppressionReason(s: Suppression): string {
  const when = new Date(s.createdAt).toISOString().slice(0, 10);
  const what = s.reason === 'complaint' ? 'marked a message from this server as spam' : s.reason === 'bounce' ? 'bounced' : 'was blocked by an administrator';
  return `Not sent: this address ${what} on ${when}${s.detail ? ` (${s.detail})` : ''}. An administrator can remove it from the suppression list.`;
}

export function listSuppressions(q = '', limit = 500): Suppression[] {
  return all<any>(`SELECT * FROM suppressions ${q ? 'WHERE address LIKE ?' : ''} ORDER BY created_at DESC LIMIT ?`, q ? [`%${q}%`, limit] : [limit]).map((r) => ({
    address: r.address,
    reason: r.reason,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}
