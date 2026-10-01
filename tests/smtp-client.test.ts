import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { dotStuff, smtpSend, smtpVerify, SmtpError } from '../src/server/mail/smtp-client';
import { getProviderDef } from '../src/server/providers/registry';

interface Received {
  from: string;
  to: string[];
  data: string;
  user?: string;
}

const received: Received[] = [];

function startServer(opts: { secure?: boolean; tls?: { key: string; cert: string } | null; disableStartTls?: boolean }) {
  const server = new SMTPServer({
    secure: !!opts.secure,
    ...(opts.tls ? { key: opts.tls.key, cert: opts.tls.cert } : {}),
    disabledCommands: opts.tls && !opts.disableStartTls ? [] : ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === 'relay' && auth.password === 'p@ss: wörd') return cb(null, { user: auth.username });
      cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
    },
    onRcptTo(addr, _session, cb) {
      if (addr.address.startsWith('nobody@')) return cb(Object.assign(new Error('No such user'), { responseCode: 550 }));
      if (addr.address.startsWith('busy@')) return cb(Object.assign(new Error('Try later'), { responseCode: 451 }));
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: (session.envelope.mailFrom as { address: string }).address,
          to: session.envelope.rcptTo.map((r) => r.address),
          data: Buffer.concat(chunks).toString('utf8'),
          user: session.user as string | undefined,
        });
        cb(null, 'OK queued as ABC123');
      });
    },
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A throwaway self-signed certificate, if openssl is available. */
function selfSigned(): { key: string; cert: string } | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wren-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`], {
      stdio: 'ignore',
    });
    return { key: fs.readFileSync(`${dir}/k.pem`, 'utf8'), cert: fs.readFileSync(`${dir}/c.pem`, 'utf8') };
  } catch {
    return null;
  }
}

const raw = new TextEncoder().encode(
  'From: Alice <alice@wren.test>\nTo: bob@example.com\nSubject: Hi\nMessage-ID: <x1@wren.test>\n\nLine one\n.starts with a dot\n..two dots\nÜnïcode\n',
);
const auth = { username: 'relay', password: 'p@ss: wörd' };
const tlsPair = selfSigned();
const servers: { close: () => Promise<void> }[] = [];
let plainPort = 0;

beforeAll(async () => {
  const s = await startServer({});
  servers.push(s);
  plainPort = s.port;
});

afterAll(async () => {
  for (const s of servers) await s.close();
});

describe('SMTP client', () => {
  it('dot-stuffs and normalises line endings', () => {
    const out = new TextDecoder().decode(dotStuff(new TextEncoder().encode('a\n.b\r\n..c\rd')));
    expect(out).toBe('a\r\n..b\r\n...c\r\nd\r\n.\r\n');
  });

  it('sends with AUTH over a plain connection', async () => {
    received.length = 0;
    const r = await smtpSend({ host: '127.0.0.1', port: plainPort, security: 'none', ...auth }, { from: 'alice@wren.test', to: ['bob@example.com', 'nobody@example.com'] }, raw);
    expect(r.accepted).toEqual(['bob@example.com']);
    expect(r.rejected.map((x) => x.address)).toEqual(['nobody@example.com']);
    expect(r.response).toMatch(/queued as ABC123/);
    expect(received[0].user).toBe('relay');
    expect(received[0].to).toEqual(['bob@example.com']);
    // The server undoes the dot-stuffing; the content must arrive unchanged (with CRLF).
    expect(received[0].data).toContain('\r\n.starts with a dot\r\n..two dots\r\nÜnïcode\r\n');
  });

  it('fails permanently on bad credentials or when every recipient is rejected', async () => {
    const bad = await smtpVerify({ host: '127.0.0.1', port: plainPort, security: 'none', username: 'relay', password: 'nope' }).catch((e) => e);
    expect(bad).toBeInstanceOf(SmtpError);
    expect(bad.code).toBe(535);
    expect(bad.permanent).toBe(true);
    expect(bad.message).not.toContain(Buffer.from('nope').toString('base64'));
    expect(bad.message).not.toContain('nope');
    const none = await smtpSend({ host: '127.0.0.1', port: plainPort, security: 'none', ...auth }, { from: 'a@wren.test', to: ['nobody@example.com'] }, raw).catch((e) => e);
    expect(none.permanent).toBe(true);
  });

  it('treats a temporary recipient failure as retryable', async () => {
    const err = await smtpSend({ host: '127.0.0.1', port: plainPort, security: 'none', ...auth }, { from: 'a@wren.test', to: ['busy@example.com'] }, raw).catch((e) => e);
    expect(err.code).toBe(451);
    expect(err.permanent).toBe(false);
  });

  it('refuses STARTTLS mode when the server does not offer it', async () => {
    const err = await smtpVerify({ host: '127.0.0.1', port: plainPort, security: 'starttls' }).catch((e) => e);
    expect(err.message).toMatch(/does not offer STARTTLS/);
  });

  it.skipIf(!tlsPair)('upgrades with STARTTLS', async () => {
    const s = await startServer({ tls: tlsPair });
    servers.push(s);
    // A self-signed certificate is rejected unless explicitly allowed.
    await expect(smtpVerify({ host: '127.0.0.1', port: s.port, security: 'starttls', ...auth })).rejects.toThrow();
    const caps = await smtpVerify({ host: '127.0.0.1', port: s.port, security: 'starttls', allowSelfSigned: true, ...auth });
    expect(caps).toContain('AUTH');
    received.length = 0;
    await smtpSend({ host: '127.0.0.1', port: s.port, security: 'starttls', allowSelfSigned: true, ...auth }, { from: 'alice@wren.test', to: ['bob@example.com'] }, raw);
    expect(received).toHaveLength(1);
  });

  it.skipIf(!tlsPair)('connects with implicit TLS', async () => {
    const s = await startServer({ secure: true, tls: tlsPair });
    servers.push(s);
    received.length = 0;
    const r = await smtpSend({ host: '127.0.0.1', port: s.port, security: 'tls', allowSelfSigned: true, ...auth }, { from: 'alice@wren.test', to: ['bob@example.com'] }, raw);
    expect(r.accepted).toEqual(['bob@example.com']);
    expect(received[0].data).toContain('Subject: Hi');
  });

  it('works through the SMTP relay provider', async () => {
    received.length = 0;
    const def = getProviderDef('smtp')!;
    const cfg = { host: '127.0.0.1', port: plainPort, security: 'none', ...auth };
    expect(await def.verify!(cfg, {} as never)).toMatch(/authenticated/);
    const r = await def.send!(
      cfg,
      { envelope: { from: 'alice@wren.test', to: ['bob@example.com'] }, raw, from: { address: 'alice@wren.test' }, to: [], cc: [], subject: 'Hi', headers: {} } as never,
      {} as never,
    );
    expect(r.providerMessageId).toBe('ABC123');
    expect(received).toHaveLength(1);
  });
});
