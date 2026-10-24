import { all, get, IN_LIST, listParam, now, run } from '../db/index.js';
import { normalizeEmail } from '../lib/addr.js';
import { userAddresses } from '../services/users.js';

export type SenderVerdict = 'spam' | 'safe';

/**
 * Remember "Report spam" / "Not spam" for the senders of these incoming messages. Each one steps a
 * sender one place along spam ← (none) → safe, so undoing a click (which sends the opposite
 * action) forgets it instead of flipping to the other verdict.
 */
export function rememberSenders(userId: number, messageIds: number[], verdict: SenderVerdict): void {
  if (!messageIds.length) return;
  const mine = new Set(userAddresses(userId));
  const rows = all<{ from_addr: string }>(
    `SELECT DISTINCT from_addr FROM messages WHERE user_id = ? AND direction = 'in' AND id IN ${IN_LIST}`,
    [userId, listParam(messageIds)],
  );
  const ts = now();
  for (const r of rows) {
    const sender = normalizeEmail(r.from_addr);
    if (!sender || mine.has(sender)) continue;
    const current = senderVerdict(userId, sender);
    if (current && current !== verdict) {
      run('DELETE FROM sender_verdicts WHERE user_id = ? AND sender = ?', [userId, sender]);
      continue;
    }
    run(
      `INSERT INTO sender_verdicts (user_id, sender, verdict, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, sender) DO UPDATE SET verdict = excluded.verdict, updated_at = excluded.updated_at`,
      [userId, sender, verdict, ts],
    );
  }
}

export function senderVerdict(userId: number, sender: string): SenderVerdict | null {
  if (!sender) return null;
  return get<{ verdict: SenderVerdict }>('SELECT verdict FROM sender_verdicts WHERE user_id = ? AND sender = ?', [userId, normalizeEmail(sender)])?.verdict ?? null;
}
