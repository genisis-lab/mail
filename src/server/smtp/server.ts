import fs from 'node:fs';
import { SMTPServer, type SMTPServerOptions, type SMTPServerSession } from 'smtp-server';
import { config } from '../config.js';
import { get, now, run } from '../db/index.js';
import { normalizeEmail } from '../lib/addr.js';
import { sha256, verifyPassword } from '../lib/crypto.js';
import { logger } from '../lib/log.js';
import { ingest } from '../mail/ingest.js';
import { enqueue } from '../mail/outbound.js';
import { putBlob } from '../mail/blobs.js';
import { parseMail } from '../mail/parse.js';
import { storeMessage, touchContacts } from '../mail/store.js';
import { isHostedDomain, resolveRecipient } from '../services/routing.js';
import { getUser, getUserByEmail, identities, sendLimit, sentToday } from '../services/users.js';
import { domainOf } from '../lib/addr.js';
import { smtpHostname } from '../services/dns.js';

const log = logger('smtp');

function smtpError(message: string, code: number) {
  const err = new Error(message) as Error & { responseCode: number };
  err.responseCode = code;
  return err;
}

function readStream(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    stream.on('end', () => (size > limit ? reject(smtpError('Message too large', 552)) : resolve(Buffer.concat(chunks))));
    stream.on('error', reject);
  });
}

function receivedHeader(session: SMTPServerSession, rcpt: string): string {
  const helo = session.hostNameAppearsAs || 'unknown';
  const proto = session.secure ? 'ESMTPS' : 'ESMTP';
  return `Received: from ${helo} (${session.clientHostname || '[unknown]'} [${session.remoteAddress}])\r\n\tby ${smtpHostname()} (Wren) with ${proto} id ${session.id}\r\n\tfor <${rcpt}>; ${new Date().toUTCString()}\r\n`;
}

/** TLS key/cert for STARTTLS, or null when not configured. */
function tlsOptions(): Pick<SMTPServerOptions, 'key' | 'cert'> | null {
  if (config.smtp.tlsKey && config.smtp.tlsCert) {
    try {
      return { key: fs.readFileSync(config.smtp.tlsKey), cert: fs.readFileSync(config.smtp.tlsCert) };
    } catch (err) {
      log.warn('Could not read SMTP TLS key/cert; STARTTLS disabled', err);
    }
  }
  return null;
}

/** MX server: accepts mail for hosted domains only (no relaying). */
export function startMxServer(): SMTPServer | null {
  if (!config.smtp.enabled) return null;
  const maxSize = config.smtp.maxSizeMb * 1024 * 1024;
  const tls = tlsOptions();
  const server = new SMTPServer({
    name: smtpHostname(),
    banner: 'Wren ESMTP ready',
    size: maxSize,
    authOptional: true,
    disabledCommands: tls ? ['AUTH'] : ['AUTH', 'STARTTLS'],
    ...(tls ?? {}),
    logger: false,
    onRcptTo(address, _session, cb) {
      const rcpt = normalizeEmail(address.address);
      if (!isHostedDomain(domainOf(rcpt))) return cb(smtpError('5.7.1 Relaying denied', 554));
      const r = resolveRecipient(rcpt);
      if (!r.userIds.length && !r.external.length) return cb(smtpError(`5.1.1 <${rcpt}>: ${r.reason ?? 'no such user'}`, 550));
      cb();
    },
    onData(stream, session, cb) {
      readStream(stream, maxSize)
        .then(async (raw) => {
          const rcpts = session.envelope.rcptTo.map((r) => r.address);
          const full = Buffer.concat([Buffer.from(receivedHeader(session, rcpts[0] ?? '')), raw]);
          const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
          const res = await ingest(full, { rcptTo: rcpts, mailFrom, source: 'smtp' });
          if (!res.accepted.length && res.rejected.length) {
            throw smtpError(`5.1.1 ${res.rejected.map((r) => `${r.rcpt}: ${r.reason}`).join('; ')}`, 550);
          }
          cb(null, 'Message accepted');
        })
        .catch((err: any) => {
          if (!err.responseCode) {
            log.error('Inbound SMTP processing failed', err);
            err = smtpError('4.3.0 Temporary processing error, try again later', 451);
          }
          cb(err);
        });
    },
  });
  server.on('error', (err) => log.error('SMTP server error', err));
  server.listen(config.smtp.port, config.smtp.host, () => log.info(`MX SMTP server listening on ${config.smtp.host}:${config.smtp.port}`));
  return server;
}

/** Authenticate with an account password (no 2FA) or a personal API key. */
async function authenticate(username: string, password: string): Promise<number | null> {
  const user = getUserByEmail(username);
  if (!user || user.status !== 'active') return null;
  const key = get<{ id: number; user_id: number }>('SELECT id, user_id FROM api_keys WHERE key_hash = ?', [sha256(password)]);
  if (key && key.user_id === user.id) {
    run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now(), key.id]);
    return user.id;
  }
  if (!user.totp_enabled && (await verifyPassword(password, user.password_hash))) return user.id;
  return null;
}

/**
 * Submission server (e.g. port 587) so desktop/mobile clients can send
 * through Wren. Requires AUTH; messages are stored in Sent and queued.
 */
export function startSubmissionServer(): SMTPServer | null {
  if (!config.smtp.submissionPort) return null;
  const maxSize = config.smtp.maxSizeMb * 1024 * 1024;
  const tls = tlsOptions();
  const server = new SMTPServer({
    name: smtpHostname(),
    banner: 'Wren submission ready',
    size: maxSize,
    authMethods: ['PLAIN', 'LOGIN'],
    allowInsecureAuth: !tls,
    disabledCommands: tls ? [] : ['STARTTLS'],
    ...(tls ?? {}),
    logger: false,
    onAuth(auth, _session, cb) {
      authenticate(auth.username ?? '', auth.password ?? '')
        .then((userId) => (userId ? cb(null, { user: userId }) : cb(smtpError('5.7.8 Authentication failed', 535))))
        .catch(() => cb(smtpError('4.7.0 Temporary authentication failure', 454)));
    },
    onMailFrom(address, session, cb) {
      const userId = session.user as unknown as number;
      const allowed = identities(userId).some((i) => i.address.toLowerCase() === normalizeEmail(address.address));
      if (!allowed) return cb(smtpError(`5.7.1 You may not send as ${address.address}`, 553));
      const user = getUser(userId);
      if (user && sentToday(userId) >= sendLimit(user)) return cb(smtpError('4.7.0 Daily sending limit reached', 451));
      cb();
    },
    onData(stream, session, cb) {
      readStream(stream, maxSize)
        .then(async (raw) => {
          const userId = session.user as unknown as number;
          const p = await parseMail(raw);
          const rcpts = session.envelope.rcptTo.map((r) => normalizeEmail(r.address));
          const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
          const rawBlob = await putBlob(raw);
          const listed = new Set([...p.to, ...p.cc].map((a) => a.address));
          const bcc = rcpts.filter((r) => !listed.has(r)).map((address) => ({ address }));
          const id = await storeMessage({
            userId,
            folder: 'sent',
            direction: 'out',
            messageId: p.messageId,
            inReplyTo: p.inReplyTo,
            references: p.references,
            from: p.from,
            to: p.to,
            cc: p.cc,
            bcc,
            replyTo: p.replyTo,
            subject: p.subject,
            text: p.text,
            html: p.html,
            date: Date.now(),
            size: raw.length,
            rawBlob,
            attachments: p.attachments,
            isRead: true,
            status: 'queued',
            identity: mailFrom,
            source: 'submission',
          });
          enqueue({ kind: 'user', userId, messageId: id, mailFrom, recipients: rcpts, rawBlob, subject: p.subject });
          touchContacts(userId, rcpts.map((address) => ({ address })));
          cb(null, 'Queued for delivery');
        })
        .catch((err: any) => {
          log.error('Submission failed', err);
          cb(err.responseCode ? err : smtpError('4.3.0 Temporary error', 451));
        });
    },
  });
  server.on('error', (err) => log.error('Submission server error', err));
  server.listen(config.smtp.submissionPort, config.smtp.host, () => log.info(`Submission SMTP server listening on ${config.smtp.host}:${config.smtp.submissionPort}`));
  return server;
}

