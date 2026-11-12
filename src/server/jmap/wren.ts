/**
 * Wren's own JMAP additions (CAP.wren; docs/jmap.md): answering calendar invitations and
 * unsubscribing from a mailing list, the PGP keys the web app keeps, and the person's Wren
 * preferences (default From and signatures). The Email "invite",
 * "canUnsubscribe" and "unsubscribed" properties are in email.ts, and
 * EmailSubmission's "privateLinkDays" in submission.ts.
 */
import { get } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { replyToInvite } from '../services/calendar.js';
import { lookupKeys } from '../services/pgp.js';
import { unsubscribe } from '../services/unsubscribe.js';
import { loadRows } from './email.js';
import { getPrefs, identities, savePrefs } from '../services/users.js';
import { MethodError, SetError } from './errors.js';
import { CAP, getIds, getProperties, isObject, method, pick, resolveId } from './request.js';

const RSVP = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' } as const;

/** Accept, maybe or decline the invitation in an email, as the web app's invite card does. */
method('Invite/reply', CAP.wren, async (args, ctx) => {
  if (!ctx.canSend) throw new MethodError('forbidden', 'You can read this shared mailbox, but not send from it');
  const status = RSVP[args.status as keyof typeof RSVP];
  if (!status) throw new MethodError('invalidArguments', 'status is accepted, tentative or declined');
  const comment = args.comment ?? '';
  if (typeof comment !== 'string' || comment.length > 2000) throw new MethodError('invalidArguments', 'comment is up to 2000 characters');
  const emailId = String(resolveId(ctx, args.emailId));
  const row = loadRows(ctx.user.id, [emailId]).get(emailId);
  if (!row) throw new MethodError('invalidArguments', 'No such email');
  try {
    const r = await replyToInvite(ctx.user.id, row.id, status, comment, ctx.actor.id);
    return { accountId: ctx.accountId, emailId, status: args.status, to: r.to };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new MethodError('invalidArguments', (err as Error).message);
  }
});

/** Unsubscribe from the list an email came from, as the web app's Unsubscribe button does. */
method('MailingList/unsubscribe', CAP.wren, async (args, ctx) => {
  // It may send mail (an unsubscribe request from the mailbox's address).
  if (!ctx.canSend) throw new MethodError('forbidden', 'You can read this shared mailbox, but not send from it');
  const emailId = String(resolveId(ctx, args.emailId));
  const row = loadRows(ctx.user.id, [emailId]).get(emailId);
  if (!row) throw new MethodError('invalidArguments', 'No such email');
  try {
    return { accountId: ctx.accountId, emailId, ...(await unsubscribe(ctx.user.id, row.id)) };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new MethodError('invalidArguments', (err as Error).message);
  }
});

/** Recipients' public keys, as the web app finds them: { address: [{ fingerprint, armored }] }. */
method('PgpKey/lookup', CAP.wren, (args, ctx) => {
  const list = args.addresses;
  if (!Array.isArray(list) || list.length > 100 || list.some((a) => typeof a !== 'string' || a.length > 254)) {
    throw new MethodError('invalidArguments', 'addresses is a list of up to 100 email addresses');
  }
  return { accountId: ctx.accountId, keys: lookupKeys(ctx.user.id, list.map((a: string) => a.trim().toLowerCase())) };
});

/** The person's private key backup, encrypted with their passphrase in the browser; the server never sees either. */
method('PgpBackup/get', CAP.wren, (args, ctx) => {
  if (ctx.user.id !== ctx.actor.id) throw new MethodError('accountNotSupportedByMethod', 'Shared mailboxes have no key backup');
  const wanted = getIds(args, ctx, true);
  const props = getProperties(args, ['fingerprint', 'armored', 'updatedAt']);
  const b = get<{ fingerprint: string; armored: string; updated_at: number }>('SELECT fingerprint, armored, updated_at FROM pgp_backups WHERE user_id = ?', [ctx.user.id]);
  const found = !!b && (!wanted || wanted.includes('singleton'));
  return {
    accountId: ctx.accountId,
    state: sha256(`${b?.fingerprint}/${b?.updated_at}`).slice(0, 16),
    list: found ? [pick({ id: 'singleton', fingerprint: b.fingerprint, armored: b.armored, updatedAt: new Date(b.updated_at).toISOString().replace(/\.\d{3}Z$/, 'Z') }, props)] : [],
    notFound: wanted ? wanted.filter((id) => id !== 'singleton' || !b) : [],
  };
});

// ── Preferences ─────────────────────────────────────────────────────────────

/**
 * The person's Wren settings that a mail app can show and change, so they match on the web: which
 * address new mail is from, the default signature and each address's own, and whether replies get
 * the signature. Settings that guard the account (forwarding, sign-in alerts, 2-step sign-in) are
 * left out on purpose: an app password reads mail, it doesn't get to send it elsewhere for good or
 * hide new sign-ins. Those stay on the web, behind the account password.
 */
function preferences(userId: number) {
  const p = getPrefs(userId);
  return { id: 'singleton', defaultFrom: p.defaultFrom, signature: p.signature, signatures: p.signatures, signatureOnReplies: p.signatureOnReplies };
}

const preferencesState = (userId: number) => sha256(JSON.stringify(preferences(userId))).slice(0, 16);

const personalOnly = (ctx: { user: { id: number }; actor: { id: number } }) => {
  if (ctx.user.id !== ctx.actor.id) throw new MethodError('accountNotSupportedByMethod', 'A shared mailbox’s settings are set by an administrator');
};

method('Preferences/get', CAP.wren, (args, ctx) => {
  personalOnly(ctx);
  const wanted = getIds(args, ctx, true);
  const props = getProperties(args, ['defaultFrom', 'signature', 'signatures', 'signatureOnReplies']);
  const found = !wanted || wanted.includes('singleton');
  return {
    accountId: ctx.accountId,
    state: preferencesState(ctx.user.id),
    list: found ? [pick(preferences(ctx.user.id), props)] : [],
    notFound: wanted ? wanted.filter((id) => id !== 'singleton') : [],
  };
});

method('Preferences/set', CAP.wren, (args, ctx) => {
  personalOnly(ctx);
  const userId = ctx.user.id;
  const oldState = preferencesState(userId);
  if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== oldState) throw new MethodError('stateMismatch', 'The preferences changed');
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  for (const [id, patch] of Object.entries<unknown>(isObject(args.update) ? args.update : {})) {
    try {
      if (id !== 'singleton') throw new SetError('notFound', 'The preferences are "singleton"');
      if (!isObject(patch)) throw new SetError('invalidPatch', 'Not an object');
      const prefs = getPrefs(userId);
      const mine = identities(userId).map((i) => i.address.toLowerCase());
      const next = { ...prefs, signatures: { ...prefs.signatures } };
      const bad = (k: string, why: string) => new SetError('invalidProperties', why, { properties: [k] });
      const signature = (k: string, v: unknown) => {
        if (typeof v !== 'string' || v.length > 20_000) throw bad(k, 'A signature is HTML, up to 20,000 characters');
        return v.trim() ? v : '';
      };
      for (const [k, val] of Object.entries(patch)) {
        if (k === 'defaultFrom') {
          if (typeof val !== 'string' || (val && !mine.includes(val.toLowerCase()))) throw bad(k, 'Pick one of your own addresses, or "" for your mailbox');
          next.defaultFrom = val.toLowerCase();
        } else if (k === 'signature') {
          next.signature = signature(k, val);
        } else if (k === 'signatureOnReplies') {
          if (typeof val !== 'boolean') throw bad(k, 'signatureOnReplies is true or false');
          next.signatureOnReplies = val;
        } else if (k === 'signatures') {
          // The whole map, as the web app saves it.
          if (!isObject(val)) throw bad(k, 'signatures maps your addresses to their signatures');
          next.signatures = {};
          for (const [address, html] of Object.entries(val)) {
            if (!mine.includes(address.toLowerCase())) throw bad(k, `${address} isn’t one of your addresses`);
            const s = signature(k, html);
            if (s) next.signatures[address.toLowerCase()] = s;
          }
        } else if (k.startsWith('signatures/')) {
          // A patch of one address's signature (RFC 8620 5.3); null or "" removes it.
          const address = k.slice('signatures/'.length).replace(/~1/g, '/').replace(/~0/g, '~').toLowerCase();
          if (!mine.includes(address)) throw bad(k, `${address} isn’t one of your addresses`);
          const s = val === null ? '' : signature(k, val);
          if (s) next.signatures[address] = s;
          else delete next.signatures[address];
        } else {
          throw bad(k, `Can’t set ${k}`);
        }
      }
      savePrefs(userId, next);
      updated[id] = null;
    } catch (err) {
      notUpdated[id] = err instanceof SetError ? err : new SetError('invalidProperties', (err as Error).message);
    }
  }
  const singleton = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, new SetError('singleton', 'There is only one set of preferences')]));
  return {
    accountId: ctx.accountId,
    oldState,
    newState: preferencesState(userId),
    created: {},
    updated,
    destroyed: [],
    notCreated: singleton(Object.keys(isObject(args.create) ? args.create : {})),
    notUpdated,
    notDestroyed: singleton(Array.isArray(args.destroy) ? (args.destroy as string[]) : []),
  };
});
