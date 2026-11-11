/** PGP key lookups, for the web app (/api/me/pgp/lookup) and mail apps (JMAP PgpKey/lookup). */
import { all } from '../db/index.js';

/**
 * The public keys known for some addresses, only for addresses that have one: the keys this
 * person saved, and the key published by whoever owns that address on this server.
 */
export function lookupKeys(userId: number, addresses: string[]): Record<string, { fingerprint: string; armored: string }[]> {
  const keys: Record<string, { fingerprint: string; armored: string }[]> = {};
  for (const address of new Set(addresses)) {
    const rows = all<{ fingerprint: string; armored: string }>(
      `SELECT fingerprint, armored FROM pgp_keys
        WHERE (user_id = ? AND own = 0 AND EXISTS (SELECT 1 FROM json_each(pgp_keys.emails) WHERE value = ?))
           OR (own = 1 AND user_id IN (SELECT user_id FROM addresses WHERE address = ? AND kind IN ('mailbox', 'alias') AND enabled = 1))
        ORDER BY own DESC, id`,
      [userId, address, address],
    );
    const unique = rows.filter((r, i) => rows.findIndex((o) => o.fingerprint === r.fingerprint) === i);
    if (unique.length) keys[address] = unique;
  }
  return keys;
}
