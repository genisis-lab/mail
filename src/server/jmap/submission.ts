/**
 * Identity/* and EmailSubmission/* (RFC 8621 sections 6 and 7). Identities are
 * the addresses a person (or a shared mailbox) may send from; a submission
 * sends a draft through Wren's normal path (identity checks, daily limits, the
 * outbound queue, providers and suppressions) and is shown from its outbox row.
 * A send held with FUTURERELEASE (HOLDUNTIL/HOLDFOR) is a scheduled send, the
 * same as the web app's: it shows in Scheduled there and can be cancelled from
 * either side, which turns it back into a draft.
 */
import { all, get, IN_LIST, listParam, now, run } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { htmlToText } from '../mail/parse.js';
import { cancelSend, sendDraft } from '../mail/send.js';
import { getPrefs, identities } from '../services/users.js';
import { emailSet, loadRows } from './email.js';
import { MethodError, SetError, asSetError } from './errors.js';
import { emailId, threadId } from './ids.js';
import { CAP, checkSetSize, getIds, isObject, method, pick, resolveId, getProperties, type JmapContext } from './request.js';

// ── Identity ────────────────────────────────────────────────────────────────

function identityList(userId: number) {
  const ids = identities(userId);
  if (!ids.length) return [];
  const rows = new Map(
    all<{ id: number; address: string }>(`SELECT id, address FROM addresses WHERE address IN ${IN_LIST}`, [listParam(ids.map((i) => i.address))]).map((r) => [r.address.toLowerCase(), r.id]),
  );
  const prefs = getPrefs(userId);
  return ids
    .filter((i) => rows.has(i.address.toLowerCase()))
    .map((i) => {
      const html = prefs.signatures[i.address] ?? prefs.signature ?? '';
      return {
        id: `I${rows.get(i.address.toLowerCase())}`,
        name: i.name,
        email: i.address,
        replyTo: null,
        bcc: null,
        textSignature: html ? htmlToText(html) : '',
        htmlSignature: html,
        mayDelete: false,
      };
    });
}

const identityState = (userId: number) => sha256(JSON.stringify(identityList(userId))).slice(0, 16);

method('Identity/get', CAP.submission, (args, ctx) => {
  const wanted = getIds(args, ctx, true);
  const props = getProperties(args, ['name', 'email', 'replyTo', 'bcc', 'textSignature', 'htmlSignature', 'mayDelete']);
  const list = identityList(ctx.user.id);
  const byId = new Map(list.map((i) => [i.id, i]));
  return {
    accountId: ctx.accountId,
    state: identityState(ctx.user.id),
    list: (wanted ? wanted.filter((id) => byId.has(id)).map((id) => byId.get(id)!) : list).map((i) => pick(i, props)),
    notFound: wanted ? wanted.filter((id) => !byId.has(id)) : [],
  };
});

method('Identity/changes', CAP.submission, (args, ctx) => {
  const state = identityState(ctx.user.id);
  if (args.sinceState !== state) throw new MethodError('cannotCalculateChanges', 'Identities changed; fetch them again');
  return { accountId: ctx.accountId, oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
});

method('Identity/set', CAP.submission, (args, ctx) => {
  const no = (what: string) => new SetError('forbidden', `${what} in Wren: Settings → Accounts`);
  return {
    accountId: ctx.accountId,
    oldState: identityState(ctx.user.id),
    newState: identityState(ctx.user.id),
    created: {},
    updated: {},
    destroyed: [],
    notCreated: Object.fromEntries(Object.keys(args.create ?? {}).map((k) => [k, no('Add addresses')])),
    notUpdated: Object.fromEntries(Object.keys(args.update ?? {}).map((k) => [k, no('Change names and signatures')])),
    notDestroyed: Object.fromEntries(((args.destroy ?? []) as string[]).map((k) => [k, no('Remove addresses')])),
  };
});

// ── EmailSubmission ─────────────────────────────────────────────────────────

interface OutboxRow {
  id: number;
  message_id: number;
  mail_from: string;
  recipients: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const utcDate = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The longest an app may hold a send (maxDelayedSend, in seconds). The web app's Schedule send
 * has no upper limit, but JMAP needs a number, so it's a year.
 */
export const MAX_DELAYED_SEND = 365 * 86_400;

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i;

/** When FUTURERELEASE (RFC 4865) asks to release the message: HOLDUNTIL or HOLDFOR on the envelope's mailFrom, or null to send now. */
function holdUntil(envelope: unknown): number | null {
  const params = isObject(envelope) && isObject(envelope.mailFrom) && isObject(envelope.mailFrom.parameters) ? envelope.mailFrom.parameters : {};
  // SMTP parameter names are case-insensitive.
  const param = (name: string) => Object.entries(params).find(([k]) => k.toUpperCase() === name)?.[1];
  const holdFor = param('HOLDFOR');
  const until = param('HOLDUNTIL');
  if (holdFor === undefined && until === undefined) return null;
  const bad = (why: string) => new SetError('invalidProperties', why, { properties: ['envelope'] });
  if (holdFor !== undefined && until !== undefined) throw bad('Use HOLDFOR or HOLDUNTIL, not both');
  const at =
    holdFor !== undefined
      ? typeof holdFor === 'string' && /^\d{1,10}$/.test(holdFor) ? now() + Number(holdFor) * 1000 : NaN
      : typeof until === 'string' && RFC3339.test(until) ? Date.parse(until) : NaN;
  if (Number.isNaN(at)) throw bad('HOLDFOR is a number of seconds, and HOLDUNTIL a date and time');
  if (at > now() + MAX_DELAYED_SEND * 1000) throw bad('Mail can be scheduled up to a year ahead');
  return at;
}

function submissionRows(userId: number, where = '', params: unknown[] = []): SubmissionRow[] {
  const rows = all<any>(
    `SELECT o.id, o.message_id, o.mail_from, o.recipients, o.status, o.last_error, o.created_at, o.updated_at,
            m.id AS m_id, m.thread_id AS m_thread_id, m.created_at AS m_created_at, m.jmap_rev AS m_jmap_rev, m.send_at AS m_send_at, m.to_json, m.cc_json, m.bcc_json,
            t.created_at AS t_created_at
       FROM outbox o JOIN messages m ON m.id = o.message_id JOIN threads t ON t.id = m.thread_id
      WHERE o.user_id = ? AND o.kind IN ('user','api') ${where}
      ORDER BY o.id DESC LIMIT 500`,
    [userId, ...params],
  );
  return rows.map((r) => ({ ...r, m: { id: r.m_id, thread_id: r.m_thread_id, created_at: r.m_created_at, jmap_rev: r.m_jmap_rev, send_at: r.m_send_at } }));
}

type SubmissionRow = OutboxRow & { m: any; t_created_at: number; to_json: string; cc_json: string; bcc_json: string };

function submission(r: SubmissionRow, identityIds: Map<string, string>) {
  // A job that ran out of recipients (all delivered or failed) still reports the email's.
  const queued = JSON.parse(r.recipients || '[]') as string[];
  const rcpts = queued.length ? queued : [...JSON.parse(r.to_json), ...JSON.parse(r.cc_json), ...JSON.parse(r.bcc_json)].map((a: { address: string }) => a.address);
  const pending = r.status === 'queued' && (r.m.send_at ?? 0) > now();
  const delivered = r.status === 'sent' ? 'unknown' : r.status === 'failed' ? 'no' : 'queued';
  const smtpReply = r.status === 'sent' ? '250 2.0.0 Accepted' : r.status === 'failed' ? `550 5.0.0 ${(r.last_error ?? 'Delivery failed').replace(/[\r\n]+/g, ' ').slice(0, 300)}` : '250 2.0.0 Queued';
  return {
    id: `S${r.id}`,
    identityId: identityIds.get(r.mail_from.toLowerCase()) ?? null,
    emailId: emailId(r.m),
    threadId: threadId({ id: r.m.thread_id, created_at: r.t_created_at }),
    envelope: { mailFrom: { email: r.mail_from, parameters: null }, rcptTo: rcpts.map((email) => ({ email, parameters: null })) },
    sendAt: utcDate(r.m.send_at ?? r.created_at),
    undoStatus: pending ? 'pending' : r.status === 'cancelled' ? 'canceled' : 'final',
    deliveryStatus: Object.fromEntries(rcpts.map((email) => [email, { smtpReply, delivered, displayed: 'unknown' }])),
    dsnBlobIds: [],
    mdnBlobIds: [],
  };
}

const identityIds = (userId: number) => new Map(identityList(userId).map((i) => [i.email.toLowerCase(), i.id]));
const submissionState = (userId: number) => {
  const r = get<{ n: number; u: number }>(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS u FROM outbox WHERE user_id = ? AND kind IN ('user','api')`, [userId]);
  return `${r?.n ?? 0}.${r?.u ?? 0}`;
};

const SUBMISSION_PROPS = ['identityId', 'emailId', 'threadId', 'envelope', 'sendAt', 'undoStatus', 'deliveryStatus', 'dsnBlobIds', 'mdnBlobIds'];

method('EmailSubmission/get', CAP.submission, (args, ctx) => {
  const wanted = getIds(args, ctx, true);
  const props = getProperties(args, SUBMISSION_PROPS);
  const numeric = (wanted ?? []).map((id) => /^S(\d+)$/.exec(id)?.[1]).filter(Boolean).map(Number);
  const rows = wanted ? (numeric.length ? submissionRows(ctx.user.id, `AND o.id IN ${IN_LIST}`, [listParam(numeric)]) : []) : submissionRows(ctx.user.id);
  const idMap = identityIds(ctx.user.id);
  const list = rows.map((r) => submission(r, idMap));
  const found = new Set(list.map((s) => s.id));
  return {
    accountId: ctx.accountId,
    state: submissionState(ctx.user.id),
    list: list.map((s) => pick(s, props)),
    notFound: wanted ? wanted.filter((id) => !found.has(id)) : [],
  };
});

method('EmailSubmission/changes', CAP.submission, () => {
  throw new MethodError('cannotCalculateChanges', 'Fetch submissions again');
});

method('EmailSubmission/query', CAP.submission, (args, ctx) => {
  const idMap = identityIds(ctx.user.id);
  let list = submissionRows(ctx.user.id).map((r) => submission(r, idMap));
  const f = isObject(args.filter) ? args.filter : {};
  if (Array.isArray(f.emailIds)) list = list.filter((s) => (f.emailIds as string[]).includes(s.emailId));
  if (Array.isArray(f.threadIds)) list = list.filter((s) => (f.threadIds as string[]).includes(s.threadId));
  if (Array.isArray(f.identityIds)) list = list.filter((s) => s.identityId && (f.identityIds as string[]).includes(s.identityId));
  if (typeof f.undoStatus === 'string') list = list.filter((s) => s.undoStatus === f.undoStatus);
  if (typeof f.before === 'string') list = list.filter((s) => s.sendAt < (f.before as string));
  if (typeof f.after === 'string') list = list.filter((s) => s.sendAt >= (f.after as string));
  const position = Math.max(0, Number(args.position) || 0);
  const limit = args.limit === undefined || args.limit === null ? list.length : Math.max(0, Number(args.limit));
  return {
    accountId: ctx.accountId,
    queryState: submissionState(ctx.user.id),
    canCalculateChanges: false,
    position,
    ids: list.slice(position, position + limit).map((s) => s.id),
    total: list.length,
  };
});

method('EmailSubmission/queryChanges', CAP.submission, () => {
  throw new MethodError('cannotCalculateChanges', 'Run EmailSubmission/query again');
});

/** Wren's send errors, as the SetError types RFC 8621 7.5 names. */
function sendError(err: unknown): SetError {
  const msg = (err as Error)?.message ?? '';
  const status = (err as { status?: number }).status;
  if (/at least one recipient/i.test(msg)) return new SetError('noRecipients', msg);
  if (/invalid address/i.test(msg)) return new SetError('invalidRecipients', msg);
  if (/too many recipients/i.test(msg)) return new SetError('tooManyRecipients', msg);
  if (/can't send as|can’t send as|no address you can send from/i.test(msg)) return new SetError('forbiddenFrom', msg);
  if (status === 429 || /limit/i.test(msg)) return new SetError('forbiddenToSend', msg);
  if (/attachments exceed/i.test(msg)) return new SetError('tooLarge', msg);
  return asSetError(err);
}

async function createSubmission(ctx: JmapContext, obj: Record<string, any>): Promise<{ id: string; emailId: string; undoStatus: string; sendAt: string }> {
  const userId = ctx.user.id;
  if (!isObject(obj)) throw new SetError('invalidProperties', 'Not an object');
  // As in the web app, members of a shared mailbox without send permission can read and draft but not send.
  if (!ctx.canSend) throw new SetError('forbiddenToSend', 'You can read this shared mailbox, but not send from it');
  const identity = identityList(userId).find((i) => i.id === resolveId(ctx, obj.identityId));
  if (!identity) throw new SetError('invalidProperties', 'No such identity', { properties: ['identityId'] });
  const eid = String(resolveId(ctx, obj.emailId));
  const row = loadRows(userId, [eid]).get(eid);
  if (!row) throw new SetError('invalidProperties', 'No such email', { properties: ['emailId'] });
  if (row.folder !== 'drafts') throw new SetError('invalidEmail', 'Only drafts can be sent', { properties: ['emailId'] });
  if (obj.sendAt !== undefined && obj.sendAt !== null) throw new SetError('invalidProperties', 'The server sets sendAt; hold the message with HOLDUNTIL or HOLDFOR', { properties: ['sendAt'] });
  const hold = holdUntil(obj.envelope);

  if (isObject(obj.envelope)) {
    const env = obj.envelope as { mailFrom?: { email?: string }; rcptTo?: { email?: string }[] };
    if (env.mailFrom?.email && env.mailFrom.email.toLowerCase() !== row.from_addr.toLowerCase() && env.mailFrom.email.toLowerCase() !== identity.email.toLowerCase()) {
      throw new SetError('forbiddenMailFrom', 'The envelope sender must be one of your addresses');
    }
    if (Array.isArray(env.rcptTo)) {
      const header = new Set<string>([...JSON.parse(row.to_json), ...JSON.parse(row.cc_json), ...JSON.parse(row.bcc_json)].map((a: { address: string }) => a.address.toLowerCase()));
      const wanted = env.rcptTo.map((r) => String(r?.email ?? '').toLowerCase()).filter(Boolean);
      if ([...header].some((a) => !wanted.includes(a))) throw new SetError('invalidProperties', 'Wren sends to every To, Cc and Bcc address of the email', { properties: ['envelope'] });
      // Envelope-only recipients are sent as Bcc.
      const extra = wanted.filter((a) => !header.has(a));
      // The email changes, so it gets a new id (emails are immutable in JMAP).
      if (extra.length) run('UPDATE messages SET bcc_json = ?, jmap_rev = jmap_rev + 1 WHERE id = ?', [JSON.stringify([...JSON.parse(row.bcc_json), ...extra.map((address) => ({ address, name: '' }))]), row.id]);
    }
  }

  let res: { sendAt: number };
  try {
    // Over 30 seconds away it's a scheduled send; a shorter hold waits like undo send does.
    res = await sendDraft(userId, row.id, { sendAt: hold, undoSeconds: hold ? Math.ceil(Math.max(0, hold - now()) / 1000) : 0, kind: 'user', sentBy: ctx.actor.id });
  } catch (err) {
    throw sendError(err);
  }
  const o = get<{ id: number }>('SELECT id FROM outbox WHERE message_id = ? ORDER BY id DESC LIMIT 1', [row.id])!;
  const sent = get<{ id: number; thread_id: number; created_at: number; jmap_rev: number }>('SELECT id, thread_id, created_at, jmap_rev FROM messages WHERE id = ?', [row.id])!;
  return { id: `S${o.id}`, emailId: emailId(sent), undoStatus: res.sendAt > now() ? 'pending' : 'final', sendAt: utcDate(res.sendAt) };
}

method('EmailSubmission/set', CAP.submission, async (args, ctx) => {
  checkSetSize(args);
  const userId = ctx.user.id;
  const oldState = submissionState(userId);
  if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== oldState) throw new MethodError('stateMismatch', 'Submissions changed');
  const created: Record<string, unknown> = {};
  const updated: Record<string, null> = {};
  const destroyed: string[] = [];
  const notCreated: Record<string, unknown> = {};
  const notUpdated: Record<string, unknown> = {};
  const notDestroyed: Record<string, unknown> = {};
  /** Submission id → its email, for onSuccess… */
  const emailOf = new Map<string, string>();

  for (const [cid, obj] of Object.entries<Record<string, any>>(args.create ?? {})) {
    try {
      const s = await createSubmission(ctx, obj);
      ctx.createdIds.set(cid, s.id);
      emailOf.set(s.id, s.emailId);
      created[cid] = { id: s.id, undoStatus: s.undoStatus, sendAt: s.sendAt };
    } catch (err) {
      notCreated[cid] = asSetError(err);
    }
  }

  for (const [rawId, patch] of Object.entries<Record<string, unknown>>(args.update ?? {})) {
    const id = String(resolveId(ctx, rawId));
    try {
      const n = /^S(\d+)$/.exec(id)?.[1];
      const r = n ? submissionRows(userId, 'AND o.id = ?', [Number(n)])[0] : undefined;
      if (!r) throw new SetError('notFound', 'No such submission');
      const keys = Object.keys(patch ?? {});
      if (keys.some((k) => k !== 'undoStatus') || patch.undoStatus !== 'canceled') throw new SetError('invalidProperties', 'Only undoStatus can change, to canceled', { properties: keys });
      // A cancelled submission can share its message with a later re-send. Never cancel that newer job.
      if (r.status === 'cancelled') {
        updated[id] = null;
        continue;
      }
      if (r.status !== 'queued') throw new SetError('cannotUnsend', 'It has already been sent');
      if (!(await cancelSend(userId, r.message_id))) throw new SetError('cannotUnsend', 'It has already been sent');
      // Taking a domain footer off makes it a new email.
      emailOf.set(id, emailId({ ...r.m, jmap_rev: get<{ jmap_rev: number }>('SELECT jmap_rev FROM messages WHERE id = ?', [r.m.id])!.jmap_rev }));
      updated[id] = null;
    } catch (err) {
      notUpdated[id] = asSetError(err);
    }
  }

  // Wren keeps the delivery record (it's the sent mail's history); destroying only forgets it here.
  for (const rawId of (args.destroy ?? []) as unknown[]) {
    const id = String(resolveId(ctx, rawId));
    const n = /^S(\d+)$/.exec(id)?.[1];
    if (n && submissionRows(userId, 'AND o.id = ?', [Number(n)]).length) destroyed.push(id);
    else notDestroyed[id] = new SetError('notFound', 'No such submission');
  }

  const result = { accountId: ctx.accountId, oldState, newState: submissionState(userId), created, updated, destroyed, notCreated, notUpdated, notDestroyed };

  // The implicit Email/set (RFC 8621 7.5): move the sent draft, or delete it.
  const done = new Set([...Object.values(created).map((c: any) => c.id), ...Object.keys(updated)]);
  const emailUpdate: Record<string, unknown> = {};
  if (isObject(args.onSuccessUpdateEmail)) {
    for (const [key, patch] of Object.entries(args.onSuccessUpdateEmail)) {
      const sid = String(resolveId(ctx, key));
      const eid = emailOf.get(sid);
      if (done.has(sid) && eid) emailUpdate[eid] = patch;
    }
  }
  const emailDestroy: string[] = [];
  if (Array.isArray(args.onSuccessDestroyEmail)) {
    for (const key of args.onSuccessDestroyEmail) {
      const sid = String(resolveId(ctx, key));
      const eid = emailOf.get(sid);
      if (done.has(sid) && eid) emailDestroy.push(eid);
    }
  }
  if (Object.keys(emailUpdate).length || emailDestroy.length) {
    ctx.extra.push(['Email/set', await emailSet({ accountId: ctx.accountId, update: emailUpdate, destroy: emailDestroy }, ctx)]);
  }
  return result;
});
