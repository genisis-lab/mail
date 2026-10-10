/** Quota/* (RFC 9425) and VacationResponse/* (RFC 8621 section 8). */
import { sha256 } from '../lib/crypto.js';
import { textToHtml } from '../mail/compose.js';
import { htmlToText } from '../mail/parse.js';
import { getPrefs, getUser, quotaBytes, savePrefs } from '../services/users.js';
import { MethodError, SetError } from './errors.js';
import { CAP, getIds, getProperties, isObject, method, pick } from './request.js';

// ── Quota ───────────────────────────────────────────────────────────────────

function quota(userId: number) {
  const user = getUser(userId)!;
  return {
    id: 'mail',
    resourceType: 'octets',
    used: user.used_bytes,
    hardLimit: quotaBytes(user),
    scope: 'account',
    name: `Storage for ${user.email}`,
    types: ['Email'],
    warnLimit: null,
    softLimit: null,
    description: null,
  };
}

const quotaState = (userId: number) => {
  const q = quota(userId);
  return sha256(`${q.used}/${q.hardLimit}`).slice(0, 16);
};

method('Quota/get', CAP.quota, (args, ctx) => {
  const wanted = getIds(args, ctx, true);
  const props = getProperties(args, ['resourceType', 'used', 'hardLimit', 'scope', 'name', 'types', 'warnLimit', 'softLimit', 'description']);
  const q = quota(ctx.user.id);
  const found = !wanted || wanted.includes('mail');
  return { accountId: ctx.accountId, state: quotaState(ctx.user.id), list: found ? [pick(q, props)] : [], notFound: wanted ? wanted.filter((id) => id !== 'mail') : [] };
});

method('Quota/changes', CAP.quota, (args, ctx) => {
  const state = quotaState(ctx.user.id);
  if (typeof args.sinceState !== 'string') throw new MethodError('invalidArguments', 'sinceState is required');
  return { accountId: ctx.accountId, oldState: args.sinceState, newState: state, hasMoreChanges: false, created: [], updated: args.sinceState === state ? [] : ['mail'], destroyed: [], updatedProperties: null };
});

method('Quota/query', CAP.quota, (_args, ctx) => ({ accountId: ctx.accountId, queryState: quotaState(ctx.user.id), canCalculateChanges: false, position: 0, ids: ['mail'], total: 1 }));

method('Quota/queryChanges', CAP.quota, () => {
  throw new MethodError('cannotCalculateChanges', 'Run Quota/query again');
});

// ── VacationResponse ────────────────────────────────────────────────────────

const utcDate = (ms: number | null) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
const isHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s);

function vacation(userId: number) {
  const v = getPrefs(userId).vacation;
  const html = v.message && isHtml(v.message) ? v.message : null;
  return {
    id: 'singleton',
    isEnabled: !!v.enabled,
    fromDate: utcDate(v.startAt),
    toDate: utcDate(v.endAt),
    subject: v.subject || null,
    textBody: v.message ? (html ? htmlToText(html) : v.message) : null,
    htmlBody: html,
  };
}

const vacationState = (userId: number) => sha256(JSON.stringify(vacation(userId))).slice(0, 16);

method('VacationResponse/get', CAP.vacation, (args, ctx) => {
  const wanted = getIds(args, ctx, true);
  const props = getProperties(args, ['isEnabled', 'fromDate', 'toDate', 'subject', 'textBody', 'htmlBody']);
  const found = !wanted || wanted.includes('singleton');
  return {
    accountId: ctx.accountId,
    state: vacationState(ctx.user.id),
    list: found ? [pick(vacation(ctx.user.id), props)] : [],
    notFound: wanted ? wanted.filter((id) => id !== 'singleton') : [],
  };
});

method('VacationResponse/set', CAP.vacation, (args, ctx) => {
  const userId = ctx.user.id;
  const oldState = vacationState(userId);
  if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== oldState) throw new MethodError('stateMismatch', 'The vacation response changed');
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, unknown> = {};
  for (const [id, patch] of Object.entries<Record<string, unknown>>(args.update ?? {})) {
    if (id !== 'singleton') {
      notUpdated[id] = new SetError('notFound', 'The vacation response is "singleton"');
      continue;
    }
    if (!isObject(patch)) {
      notUpdated[id] = new SetError('invalidPatch', 'Not an object');
      continue;
    }
    const prefs = getPrefs(userId);
    const v = { ...prefs.vacation };
    const date = (x: unknown) => (x === null ? null : typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? Date.parse(x) : undefined);
    try {
      for (const [k, val] of Object.entries(patch)) {
        if (k === 'isEnabled' && typeof val === 'boolean') v.enabled = val;
        else if (k === 'subject' && (typeof val === 'string' || val === null)) v.subject = (val ?? '').slice(0, 200);
        else if (k === 'htmlBody' && (typeof val === 'string' || val === null)) {
          if (val) v.message = val.slice(0, 20_000);
          else if (!('textBody' in patch)) v.message = '';
        } else if (k === 'textBody' && (typeof val === 'string' || val === null)) {
          // HTML wins when both are given.
          if (!patch.htmlBody) v.message = val ? textToHtml(val.slice(0, 20_000)) : '';
        } else if ((k === 'fromDate' || k === 'toDate') && date(val) !== undefined) {
          if (k === 'fromDate') v.startAt = date(val)!;
          else v.endAt = date(val)!;
        } else throw new SetError('invalidProperties', `Can't set ${k}`, { properties: [k] });
      }
      savePrefs(userId, { ...prefs, vacation: v });
      updated[id] = null;
    } catch (err) {
      notUpdated[id] = err instanceof SetError ? err : new SetError('invalidProperties', (err as Error).message);
    }
  }
  const notCreated = Object.fromEntries(Object.keys(args.create ?? {}).map((k) => [k, new SetError('singleton', 'There is only one vacation response')]));
  const notDestroyed = Object.fromEntries(((args.destroy ?? []) as string[]).map((k) => [k, new SetError('singleton', 'There is only one vacation response')]));
  return { accountId: ctx.accountId, oldState, newState: vacationState(userId), created: {}, updated, destroyed: [], notCreated, notUpdated, notDestroyed };
});
