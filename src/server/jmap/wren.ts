/**
 * Wren's own JMAP additions (CAP.wren; docs/jmap.md): answering calendar invitations and
 * the PGP keys the web app keeps. The Email "invite" property is in email.ts, and
 * EmailSubmission's "privateLinkDays" in submission.ts.
 */
import { get } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { replyToInvite } from '../services/calendar.js';
import { lookupKeys } from '../services/pgp.js';
import { loadRows } from './email.js';
import { MethodError } from './errors.js';
import { CAP, getIds, getProperties, method, pick, resolveId } from './request.js';

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
