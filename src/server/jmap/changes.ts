/**
 * The JMAP change log. Triggers on messages, message_labels, labels and
 * threads (migration 13) write one row per change a JMAP client can see, so
 * every code path that changes mail is covered, including ones added later.
 *
 * A mailbox has one counter (modseq) for every type. A state string is
 * "{modseq}-{tag}", where tag is the random tag of the change at that modseq
 * (or the mailbox's random base before any change). A state stops matching if
 * the database moves backwards (a restored backup, point-in-time recovery):
 * the row at that modseq is gone or has another tag, and the client is told
 * to resync instead of being handed the wrong changes.
 */
import { all, get, now, run } from '../db/index.js';
import { MethodError } from './errors.js';

export type ChangeType = 'Email' | 'Mailbox' | 'Thread';

interface ModseqRow {
  user_id: number;
  modseq: number;
  floor: number;
  pushed: number;
  base: string;
}

/** Changes are kept this long; older states get cannotCalculateChanges and resync. */
const KEEP_SECONDS = 30 * 86_400;

function modseqRow(userId: number): ModseqRow {
  let row = get<ModseqRow>('SELECT * FROM jmap_modseq WHERE user_id = ?', [userId]);
  if (!row) {
    run(`INSERT OR IGNORE INTO jmap_modseq (user_id, base) VALUES (?, lower(hex(randomblob(6))))`, [userId]);
    row = get<ModseqRow>('SELECT * FROM jmap_modseq WHERE user_id = ?', [userId])!;
  }
  return row;
}

function stateAt(userId: number, row: ModseqRow, modseq: number): string {
  if (modseq <= row.floor && modseq === 0) return `0-${row.base}`;
  const tag = get<{ tag: string }>('SELECT tag FROM jmap_changes WHERE user_id = ? AND modseq = ?', [userId, modseq])?.tag;
  return tag ? `${modseq}-${tag}` : `0-${row.base}`;
}

/** The mailbox's current state (the same string for every type). */
export function currentState(userId: number): string {
  const row = modseqRow(userId);
  return stateAt(userId, row, row.modseq);
}

export function currentModseq(userId: number): number {
  return modseqRow(userId).modseq;
}

/** The modseq a state string stands for, or null when it can't be used to calculate changes. */
function resolveState(userId: number, state: unknown): number | null {
  const m = typeof state === 'string' ? /^(\d{1,15})-([0-9a-f]{1,32})$/.exec(state) : null;
  if (!m) return null;
  const modseq = Number(m[1]);
  const row = modseqRow(userId);
  if (modseq > row.modseq) return null;
  if (modseq === 0) return row.floor === 0 && m[2] === row.base ? 0 : null;
  if (modseq <= row.floor) return null;
  const tag = get<{ tag: string }>('SELECT tag FROM jmap_changes WHERE user_id = ? AND modseq = ?', [userId, modseq])?.tag;
  return tag === m[2] ? modseq : null;
}

export interface ChangesResult {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

interface ChangeRow {
  modseq: number;
  type: ChangeType;
  obj: string;
  kind: 'c' | 'u' | 'd';
  thread: string | null;
}

/**
 * What changed for one type since a state. Threads also change when an email
 * joins or leaves them (the email rows carry their thread).
 */
export function changesSince(userId: number, type: ChangeType, sinceState: unknown, maxChanges?: number | null): ChangesResult {
  if (maxChanges !== undefined && maxChanges !== null && !(Number.isInteger(maxChanges) && maxChanges > 0)) {
    throw new MethodError('invalidArguments', 'maxChanges must be a positive integer');
  }
  const since = resolveState(userId, sinceState);
  if (since === null) throw new MethodError('cannotCalculateChanges', 'That state is too old or unknown. Sync again from the start.');
  const row = modseqRow(userId);
  const rows =
    type === 'Thread'
      ? all<ChangeRow>(`SELECT modseq, type, obj, kind, thread FROM jmap_changes WHERE user_id = ? AND modseq > ? AND type IN ('Thread','Email') ORDER BY modseq`, [userId, since])
      : all<ChangeRow>(`SELECT modseq, type, obj, kind, thread FROM jmap_changes WHERE user_id = ? AND modseq > ? AND type = ? ORDER BY modseq`, [userId, since, type]);

  const seen = new Map<string, { first: ChangeRow['kind']; last: ChangeRow['kind'] }>();
  let upTo = row.modseq;
  let hasMoreChanges = false;
  for (const r of rows) {
    const obj = r.type === type ? r.obj : r.thread;
    if (!obj) continue;
    const kind = r.type === type ? r.kind : 'u';
    const entry = seen.get(obj);
    if (!entry && maxChanges && seen.size >= maxChanges) {
      hasMoreChanges = true;
      upTo = r.modseq - 1;
      break;
    }
    if (entry) entry.last = kind;
    else seen.set(obj, { first: kind, last: kind });
  }
  const created: string[] = [];
  const updated: string[] = [];
  const destroyed: string[] = [];
  for (const [obj, { first, last }] of seen) {
    if (first === 'c') {
      if (last !== 'd') created.push(obj);
    } else if (last === 'd') destroyed.push(obj);
    // Destroyed, then a new object with the same id (can't happen with created_at in the id): report it as changed.
    else updated.push(obj);
  }
  return { oldState: stateAt(userId, row, since), newState: stateAt(userId, row, upTo), hasMoreChanges, created, updated, destroyed };
}

/** Whether anything of this type changed since a (valid) state. */
export function hasChangesSince(userId: number, type: ChangeType, sinceState: unknown): boolean {
  const since = resolveState(userId, sinceState);
  if (since === null) throw new MethodError('cannotCalculateChanges', 'That state is too old or unknown. Sync again from the start.');
  return !!get('SELECT 1 FROM jmap_changes WHERE user_id = ? AND modseq > ? AND type = ? LIMIT 1', [userId, since, type]);
}

/** Throw stateMismatch when a /set call's ifInState doesn't match. */
export function checkState(userId: number, ifInState: unknown) {
  if (ifInState !== undefined && ifInState !== null && ifInState !== currentState(userId)) {
    throw new MethodError('stateMismatch', 'The data changed since that state');
  }
}

/** Drop changes older than KEEP_SECONDS, keeping each mailbox's latest one (its current state). */
export function pruneChanges() {
  const cutoff = Math.floor(now() / 1000) - KEEP_SECONDS;
  for (const r of all<{ user_id: number; upto: number }>(
    `SELECT c.user_id, MAX(c.modseq) AS upto FROM jmap_changes c JOIN jmap_modseq q ON q.user_id = c.user_id
      WHERE c.at < ? AND c.modseq < q.modseq GROUP BY c.user_id`,
    [cutoff],
  )) {
    run('DELETE FROM jmap_changes WHERE user_id = ? AND modseq <= ?', [r.user_id, r.upto]);
    run('UPDATE jmap_modseq SET floor = MAX(floor, ?) WHERE user_id = ?', [r.upto, r.user_id]);
  }
}
