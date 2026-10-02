/**
 * A small IMAP4rev1 client (RFC 3501), just enough to import mail: login,
 * list folders, select, search and fetch by UID. Runs over `platform().tcp`
 * (cloudflare:sockets on Workers). Literals ({n}) are handled byte-exactly.
 */
import { platform, type TcpSocket } from '../platform.js';

export interface ImapOptions {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  password: string;
  allowSelfSigned?: boolean;
  timeoutMs?: number;
}

export class ImapError extends Error {
  constructor(
    message: string,
    readonly authFailed = false,
  ) {
    super(message);
  }

  /** A wrong password won't fix itself; background jobs stop instead of retrying. */
  get permanent() {
    return this.authFailed;
  }
}

/** One response line, with any literals in place: text, literal, text, literal, … */
type Segments = (string | Uint8Array)[];

export interface Mailbox {
  name: string;
  /** Human-readable name (modified UTF-7 decoded). */
  display: string;
  flags: string[];
  delimiter: string | null;
}

export interface FetchedMessage {
  uid: number;
  flags: string[];
  internalDate: number | null;
  raw: Uint8Array;
}

const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Quote a string for IMAP (ASCII only; callers fall back to literals or AUTHENTICATE otherwise). */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Decode IMAP's modified UTF-7 mailbox names (RFC 3501 §5.1.3). */
export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_m, b64: string) => {
    if (!b64) return '&';
    const bin = atob(b64.replace(/,/g, '/') + '==='.slice((b64.length + 3) % 4));
    let out = '';
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return out;
  });
}

export class ImapConnection {
  private buf: Uint8Array = new Uint8Array(0);
  private tag = 0;
  capabilities = new Set<string>();

  private constructor(
    private sock: TcpSocket,
    private timeoutMs: number,
  ) {}

  static async open(opts: ImapOptions): Promise<ImapConnection> {
    const tcp = platform().tcp;
    if (!tcp) throw new ImapError('Outbound connections are not available here');
    const timeout = opts.timeoutMs ?? 30_000;
    const sock = await withTimeout(
      tcp.connect({ host: opts.host, port: Number(opts.port), tls: opts.security === 'tls', starttls: opts.security === 'starttls', allowSelfSigned: !!opts.allowSelfSigned }),
      timeout,
      `Timed out connecting to ${opts.host}:${opts.port}`,
    );
    const conn = new ImapConnection(sock, timeout);
    try {
      const greeting = await conn.readResponse();
      const text = segText(greeting);
      if (!/^\* (OK|PREAUTH)/i.test(text)) throw new ImapError(`Unexpected greeting: ${text.slice(0, 120)}`);
      conn.parseCapabilities(text);
      if (!conn.capabilities.size) await conn.refreshCapabilities();
      if (opts.security === 'starttls') {
        if (!conn.capabilities.has('STARTTLS')) throw new ImapError(`${opts.host} does not offer STARTTLS`);
        await conn.command('STARTTLS');
        conn.sock = await conn.sock.startTls();
        conn.buf = new Uint8Array(0);
        await conn.refreshCapabilities();
      }
      await conn.login(opts.username, opts.password);
      return conn;
    } catch (err) {
      await conn.close();
      throw err;
    }
  }

  private parseCapabilities(text: string) {
    const m = /\[CAPABILITY ([^\]]+)\]|^\* CAPABILITY (.+)$/im.exec(text);
    if (m) this.capabilities = new Set((m[1] ?? m[2]).toUpperCase().split(/\s+/));
  }

  private async refreshCapabilities() {
    const r = await this.command('CAPABILITY');
    for (const line of r.untagged) this.parseCapabilities(segText(line));
  }

  private async login(user: string, pass: string) {
    const ascii = /^[\x20-\x7e]*$/.test(user + pass);
    try {
      if (this.capabilities.has('AUTH=PLAIN') || !ascii) {
        const b64 = btoa(String.fromCharCode(...enc.encode(`\0${user}\0${pass}`)));
        if (this.capabilities.has('SASL-IR')) {
          await this.command(`AUTHENTICATE PLAIN ${b64}`, true);
        } else {
          await this.command('AUTHENTICATE PLAIN', true, b64);
        }
      } else {
        await this.command(`LOGIN ${quote(user)} ${quote(pass)}`, true);
      }
    } catch (err) {
      if (err instanceof ImapError) throw new ImapError(`Sign-in failed: ${err.message}`, true);
      throw err;
    }
    await this.refreshCapabilities();
  }

  // ── Wire protocol ─────────────────────────────────────────────────────────

  private async fill(): Promise<void> {
    const chunk = await withTimeout(this.sock.read(), this.timeoutMs, 'Timed out waiting for the IMAP server');
    if (chunk === null) throw new ImapError('The IMAP server closed the connection');
    this.buf = concat(this.buf, chunk);
  }

  /** Read one logical response (a line plus any literals it announces). */
  private async readResponse(): Promise<Segments> {
    const segs: Segments = [];
    let text = '';
    for (;;) {
      let nl = this.buf.indexOf(0x0a);
      while (nl < 0) {
        await this.fill();
        nl = this.buf.indexOf(0x0a);
      }
      const line = latin1.decode(this.buf.subarray(0, nl + 1));
      this.buf = this.buf.subarray(nl + 1);
      const lit = /\{(\d+)\+?\}\r?\n$/.exec(line);
      if (!lit) {
        text += line.replace(/\r?\n$/, '');
        segs.push(text);
        return segs;
      }
      text += line.slice(0, lit.index);
      segs.push(text);
      text = '';
      const n = Number(lit[1]);
      while (this.buf.length < n) await this.fill();
      segs.push(this.buf.slice(0, n));
      this.buf = this.buf.subarray(n);
    }
  }

  /** Send a tagged command and collect untagged responses until its completion. */
  async command(cmd: string, sensitive = false, continuation?: string): Promise<{ untagged: Segments[]; text: string }> {
    const tag = `w${++this.tag}`;
    await this.sock.write(enc.encode(`${tag} ${cmd}\r\n`));
    const untagged: Segments[] = [];
    for (;;) {
      const r = await this.readResponse();
      const first = typeof r[0] === 'string' ? r[0] : '';
      if (first.startsWith('+')) {
        if (continuation === undefined) throw new ImapError('Unexpected continuation request');
        await this.sock.write(enc.encode(`${continuation}\r\n`));
        continuation = undefined;
        continue;
      }
      if (first.startsWith(`${tag} `)) {
        const m = /^\S+ (OK|NO|BAD)\s*(.*)$/i.exec(first);
        if (!m || m[1].toUpperCase() !== 'OK') {
          const what = sensitive ? cmd.split(' ')[0] : cmd.slice(0, 60);
          throw new ImapError(`${what}: ${m?.[2] || first}`);
        }
        return { untagged, text: m[2] };
      }
      untagged.push(r);
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  async list(): Promise<Mailbox[]> {
    const r = await this.command('LIST "" "*"');
    const out: Mailbox[] = [];
    for (const segs of r.untagged) {
      const head = typeof segs[0] === 'string' ? segs[0] : '';
      const m = /^\* LIST \(([^)]*)\) (NIL|"(?:[^"\\]|\\.)*") ?(.*)$/i.exec(head);
      if (!m) continue;
      let name: string;
      if (segs.length > 1 && segs[1] instanceof Uint8Array) name = latin1.decode(segs[1]);
      else if (m[3].startsWith('"')) name = m[3].slice(1, -1).replace(/\\(.)/g, '$1');
      else name = m[3];
      const delimiter = m[2].toUpperCase() === 'NIL' ? null : m[2].slice(1, -1).replace(/\\(.)/g, '$1');
      out.push({ name, display: decodeMailboxName(name), flags: m[1].split(/\s+/).filter(Boolean), delimiter });
    }
    return out;
  }

  async status(name: string): Promise<{ messages: number; uidNext: number; uidValidity: number }> {
    const r = await this.command(`STATUS ${quote(name)} (MESSAGES UIDNEXT UIDVALIDITY)`);
    const text = r.untagged.map(segText).join(' ');
    const n = (k: string) => Number(new RegExp(`${k} (\\d+)`, 'i').exec(text)?.[1] ?? 0);
    return { messages: n('MESSAGES'), uidNext: n('UIDNEXT'), uidValidity: n('UIDVALIDITY') };
  }

  async select(name: string): Promise<{ exists: number; uidValidity: number }> {
    const r = await this.command(`EXAMINE ${quote(name)}`);
    let exists = 0;
    let uidValidity = 0;
    for (const segs of r.untagged) {
      const t = segText(segs);
      const e = /^\* (\d+) EXISTS/i.exec(t);
      if (e) exists = Number(e[1]);
      const v = /UIDVALIDITY (\d+)/i.exec(t);
      if (v) uidValidity = Number(v[1]);
    }
    return { exists, uidValidity };
  }

  /** UIDs greater than `after`, ascending. */
  async uidsAfter(after: number): Promise<number[]> {
    const r = await this.command(`UID SEARCH UID ${after + 1}:*`);
    const uids = new Set<number>();
    for (const segs of r.untagged) {
      const m = /^\* SEARCH ?(.*)$/i.exec(segText(segs));
      if (m) for (const u of m[1].trim().split(/\s+/).filter(Boolean)) if (Number(u) > after) uids.add(Number(u));
    }
    return [...uids].sort((a, b) => a - b);
  }

  async fetch(uids: number[]): Promise<FetchedMessage[]> {
    if (!uids.length) return [];
    const r = await this.command(`UID FETCH ${uids.join(',')} (UID FLAGS INTERNALDATE BODY.PEEK[])`);
    const out: FetchedMessage[] = [];
    for (const segs of r.untagged) {
      const head = typeof segs[0] === 'string' ? segs[0] : '';
      if (!/^\* \d+ FETCH/i.test(head)) continue;
      const text = segs.filter((s): s is string => typeof s === 'string').join(' ');
      const uid = Number(/UID (\d+)/i.exec(text)?.[1] ?? 0);
      const flags = (/FLAGS \(([^)]*)\)/i.exec(text)?.[1] ?? '').split(/\s+/).filter(Boolean);
      const date = /INTERNALDATE "([^"]+)"/i.exec(text)?.[1];
      let raw: Uint8Array | null = null;
      for (let i = 0; i < segs.length - 1; i++) {
        if (typeof segs[i] === 'string' && /BODY\[\](<\d+>)? ?$/i.test(segs[i] as string) && segs[i + 1] instanceof Uint8Array) raw = segs[i + 1] as Uint8Array;
      }
      if (!raw) {
        const q = /BODY\[\](?:<\d+>)? "((?:[^"\\]|\\.)*)"/i.exec(text);
        if (q) raw = enc.encode(q[1].replace(/\\(.)/g, '$1'));
      }
      if (uid && raw) out.push({ uid, flags, internalDate: date ? parseImapDate(date) : null, raw });
    }
    return out;
  }

  async close() {
    try {
      await this.sock.write(enc.encode(`w${++this.tag} LOGOUT\r\n`));
    } catch {
      /* already closed */
    }
    await this.sock.close().catch(() => {});
  }
}

function segText(segs: Segments): string {
  return segs.filter((s): s is string => typeof s === 'string').join(' ');
}

/** "17-Jul-1996 02:44:25 -0700" → epoch ms */
export function parseImapDate(s: string): number | null {
  const m = /^\s*(\d{1,2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  const offset = (Number(m[8]) * 60 + Number(m[9])) * (m[7] === '-' ? -1 : 1);
  return Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(new ImapError(message)), ms)))]).finally(() => clearTimeout(t));
}
