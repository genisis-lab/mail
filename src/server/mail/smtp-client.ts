/**
 * A small SMTP submission client (RFC 5321) used by the "SMTP relay" provider.
 *
 * It talks to the network through `platform().tcp`: `connect()` from
 * cloudflare:sockets on Workers (node:net/tls in tests). Supports implicit TLS
 * (465), STARTTLS (587), AUTH PLAIN and LOGIN, SIZE, 8BITMIME and SMTPUTF8.
 */
import { platform, type TcpSocket } from '../platform.js';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpOptions {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
  allowSelfSigned?: boolean;
  /** Name sent with EHLO. */
  clientName?: string;
  timeoutMs?: number;
}

export interface SmtpResult {
  accepted: string[];
  rejected: { address: string; code: number; message: string }[];
  /** Final server response to DATA, usually containing a queue id. */
  response: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
  get permanent() {
    return !!this.code && this.code >= 500 && this.code < 600;
  }
}

interface Reply {
  code: number;
  lines: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

class Session {
  private buf = '';
  constructor(
    private sock: TcpSocket,
    private timeoutMs: number,
  ) {}

  upgrade(sock: TcpSocket) {
    this.sock = sock;
    this.buf = '';
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        return line;
      }
      const chunk = await withTimeout(this.sock.read(), this.timeoutMs, 'Timed out waiting for the SMTP server');
      if (chunk === null) throw new SmtpError('The SMTP server closed the connection');
      this.buf += dec.decode(chunk, { stream: true });
    }
  }

  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) throw new SmtpError(`Unexpected SMTP reply: ${line.slice(0, 200)}`);
      lines.push(m[3]);
      if (m[2] === ' ') return { code: Number(m[1]), lines };
    }
  }

  async command(line: string, expect: number | number[], redact = false): Promise<Reply> {
    await this.sock.write(enc.encode(line + '\r\n'));
    const r = await this.reply();
    const ok = Array.isArray(expect) ? expect.includes(r.code) : r.code === expect;
    // Never echo credentials (AUTH arguments) into error messages or logs.
    if (!ok) throw replyError(redact ? 'AUTH' : line, r);
    return r;
  }

  async write(data: Uint8Array) {
    await this.sock.write(data);
  }
}

function replyError(cmd: string, r: Reply) {
  return new SmtpError(`${cmd.replace(/\r?\n$/, '')}: ${r.code} ${r.lines.join(' ')}`.slice(0, 500), r.code);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(new SmtpError(message)), ms)))]).finally(() => clearTimeout(t));
}

const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));

/** Normalise line endings to CRLF, dot-stuff, and terminate with CRLF.CRLF. */
export function dotStuff(raw: Uint8Array): Uint8Array {
  let buf = new Uint8Array(raw.length + Math.ceil(raw.length / 32) + 8);
  let o = 0;
  const push = (b: number) => {
    if (o === buf.length) {
      const bigger = new Uint8Array(buf.length * 2);
      bigger.set(buf);
      buf = bigger;
    }
    buf[o++] = b;
  };
  let lineStart = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (lineStart && c === 0x2e) push(0x2e);
    if (c === 0x0d && raw[i + 1] !== 0x0a) {
      // Bare CR becomes CRLF.
      push(0x0d);
      push(0x0a);
      lineStart = true;
      continue;
    }
    if (c === 0x0a && raw[i - 1] !== 0x0d) push(0x0d);
    push(c);
    lineStart = c === 0x0a;
  }
  if (!lineStart) {
    push(0x0d);
    push(0x0a);
  }
  push(0x2e);
  push(0x0d);
  push(0x0a);
  return buf.subarray(0, o);
}

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

function hasEightBit(raw: Uint8Array) {
  for (let i = 0; i < raw.length; i++) if (raw[i] > 0x7f) return true;
  return false;
}

async function open(opts: SmtpOptions): Promise<{ s: Session; caps: Map<string, string>; close: () => Promise<void> }> {
  const tcp = platform().tcp;
  if (!tcp) throw new SmtpError('Outbound TCP connections are not available on this platform');
  const timeout = opts.timeoutMs ?? 30_000;
  let sock = await withTimeout(
    tcp.connect({ host: opts.host, port: Number(opts.port), tls: opts.security === 'tls', starttls: opts.security === 'starttls', allowSelfSigned: !!opts.allowSelfSigned }),
    timeout,
    `Timed out connecting to ${opts.host}:${opts.port}`,
  );
  const s = new Session(sock, timeout);
  const close = async () => {
    try {
      await sock.write(enc.encode('QUIT\r\n'));
    } catch {
      /* already closed */
    }
    await sock.close().catch(() => {});
  };
  try {
    const greeting = await s.reply();
    if (greeting.code !== 220) throw replyError('Greeting', greeting);
    const name = opts.clientName || 'localhost';
    let caps = await ehlo(s, name);
    if (opts.security === 'starttls') {
      if (!caps.has('STARTTLS')) throw new SmtpError(`${opts.host} does not offer STARTTLS. Choose implicit TLS (465) or no encryption.`);
      await s.command('STARTTLS', 220);
      sock = await sock.startTls();
      s.upgrade(sock);
      caps = await ehlo(s, name);
    }
    if (opts.username) await auth(s, caps, opts.username, opts.password ?? '');
    return { s, caps, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function ehlo(s: Session, name: string): Promise<Map<string, string>> {
  const caps = new Map<string, string>();
  try {
    const r = await s.command(`EHLO ${name}`, 250);
    for (const line of r.lines.slice(1)) {
      const [k, ...rest] = line.split(' ');
      caps.set(k.toUpperCase(), rest.join(' ').toUpperCase());
    }
  } catch (err) {
    if (!(err instanceof SmtpError) || !err.code) throw err;
    await s.command(`HELO ${name}`, 250);
  }
  return caps;
}

async function auth(s: Session, caps: Map<string, string>, user: string, pass: string) {
  const methods = (caps.get('AUTH') ?? '').split(/\s+/);
  if (methods.includes('PLAIN') || !methods.includes('LOGIN')) {
    await s.command(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, 235, true);
    return;
  }
  await s.command('AUTH LOGIN', 334);
  await s.command(b64(user), 334, true);
  await s.command(b64(pass), 235, true);
}

/** Check that we can connect, upgrade to TLS and authenticate. */
export async function smtpVerify(opts: SmtpOptions): Promise<string[]> {
  const { caps, close } = await open(opts);
  await close();
  return [...caps.keys()];
}

/** Deliver one message to the relay. Throws SmtpError if no recipient is accepted. */
export async function smtpSend(opts: SmtpOptions, envelope: { from: string; to: string[] }, raw: Uint8Array): Promise<SmtpResult> {
  const { s, caps, close } = await open(opts);
  try {
    const utf8 = !isAscii(envelope.from) || envelope.to.some((a) => !isAscii(a));
    if (utf8 && !caps.has('SMTPUTF8')) throw new SmtpError('The SMTP server does not support internationalised (SMTPUTF8) addresses', 553);
    const params = [
      caps.has('SIZE') ? `SIZE=${raw.length}` : '',
      caps.has('8BITMIME') && hasEightBit(raw) ? 'BODY=8BITMIME' : '',
      utf8 ? 'SMTPUTF8' : '',
    ].filter(Boolean);
    await s.command(`MAIL FROM:<${envelope.from}>${params.length ? ' ' + params.join(' ') : ''}`, 250);

    const accepted: string[] = [];
    const rejected: SmtpResult['rejected'] = [];
    for (const rcpt of envelope.to) {
      try {
        await s.command(`RCPT TO:<${rcpt}>`, [250, 251]);
        accepted.push(rcpt);
      } catch (err) {
        if (!(err instanceof SmtpError) || !err.code) throw err;
        if (!err.permanent) throw err; // temporary failure: retry the whole message later
        rejected.push({ address: rcpt, code: err.code, message: err.message });
      }
    }
    if (!accepted.length) {
      throw new SmtpError(`All recipients rejected: ${rejected.map((r) => r.message).join('; ')}`, rejected[0]?.code ?? 550);
    }
    await s.command('DATA', 354);
    const data = dotStuff(raw);
    for (let i = 0; i < data.length; i += 64 * 1024) await s.write(data.subarray(i, i + 64 * 1024));
    const r = await s.reply();
    if (r.code !== 250) throw replyError('DATA', r);
    return { accepted, rejected, response: `${r.code} ${r.lines.join(' ')}` };
  } finally {
    await close();
  }
}
