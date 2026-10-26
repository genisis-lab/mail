/**
 * DMARC aggregate reports (RFC 7489 appendix C). The DMARC record we publish
 * asks receivers to send them to postmaster@<domain>; they arrive as XML,
 * usually gzipped or zipped, once a day per receiver. Reading them shows
 * admins who sends mail as their domains and whether it passes.
 */
import { all, get, insert, now, run, tx } from '../db/index.js';
import { logger } from '../lib/log.js';
import { hostedDomains } from '../services/routing.js';
import type { Parsed, ParsedAttachment } from './parse.js';

const log = logger('dmarc');
const DAY = 24 * 60 * 60_000;
/** Most a report may unpack to: the biggest receivers' daily reports are well under this. */
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_ATTACHMENTS = 5;
export const RETENTION_DAYS = 180;

export interface DmarcRecord {
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  headerFrom: string;
}

export interface DmarcReport {
  org: string;
  email: string;
  reportId: string;
  begin: number;
  end: number;
  domain: string;
  policy: string;
  subdomainPolicy: string;
  pct: number | null;
  records: DmarcRecord[];
}

// ── Unpacking ───────────────────────────────────────────────────────────────

/** Decompress with DecompressionStream, giving up (null) past `cap` bytes or on corrupt data. */
async function inflate(data: Uint8Array, format: 'gzip' | 'deflate-raw', cap: number): Promise<Uint8Array | null> {
  const input = new ReadableStream<BufferSource>({
    start(c) {
      c.enqueue(data as Uint8Array<ArrayBuffer>);
      c.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream(format)).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The first .xml file in a zip archive (stored or deflated); null for anything else. */
async function unzipXml(buf: Uint8Array, cap: number): Promise<Uint8Array | null> {
  if (buf.length < 22) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: 22 bytes plus a comment of up to 64 KB, at the very end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = Math.min(dv.getUint16(eocd + 10, true), 16);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) return null;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    if (!/\.xml$/i.test(name) || flags & 1 /* encrypted */) continue;
    // Also catches zip64 (sizes of 0xffffffff), which no report needs.
    if (usize > cap || csize > buf.length) return null;
    if (local + 30 > buf.length || dv.getUint32(local, true) !== 0x04034b50) return null;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (start + csize > buf.length) return null;
    const data = buf.subarray(start, start + csize);
    if (method === 0) return data;
    if (method === 8) return inflate(data, 'deflate-raw', cap);
    return null;
  }
  return null;
}

const REPORT_NAME = /\.(xml|xml\.gz|gz|zip)$/i;
const REPORT_TYPE = /^(application\/(gzip|x-gzip|zip|x-zip|x-zip-compressed|xml)|text\/xml)$/i;

/** An attachment that could be a report: named or typed like one. */
export function looksLikeReport(a: ParsedAttachment): boolean {
  return REPORT_NAME.test(a.filename ?? '') || REPORT_TYPE.test(a.contentType ?? '');
}

/** The report's XML text, whatever it was packed in (sniffed from the bytes, not the name). */
export async function unpackReport(content: Uint8Array, cap = MAX_REPORT_BYTES): Promise<string | null> {
  let xml: Uint8Array | null = null;
  if (content[0] === 0x1f && content[1] === 0x8b) xml = await inflate(content, 'gzip', cap);
  else if (content[0] === 0x50 && content[1] === 0x4b && content[2] === 0x03 && content[3] === 0x04) xml = await unzipXml(content, cap);
  else if (content.length <= cap) xml = content;
  if (!xml) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(xml);
  return /<(?:[\w.-]+:)?feedback[\s>]/.test(text) ? text : null;
}

// ── Reading the XML ─────────────────────────────────────────────────────────
// A few well-known elements are pulled out by pattern: no DOM, no DTDs, no entity
// expansion beyond the five predefined ones, so nothing in the file can reach out.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? '';
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .trim();
}

const tagRe = (tag: string, flags = '') => new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`, flags);

/** Inner XML of the first `tag` element ('' if none). */
function section(xml: string, tag: string): string {
  return tagRe(tag).exec(xml)?.[1] ?? '';
}

/** Text of the first `tag` element, cut to `max` characters. */
function text(xml: string, tag: string, max = 200): string {
  return unescape(section(xml, tag)).slice(0, max);
}

const word = (v: string) => (/^[a-z0-9_-]{1,20}$/i.test(v) ? v.toLowerCase() : v ? 'other' : 'none');
const DOMAIN = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9])?)+$/;
const IP = /^[0-9a-f:.]{2,45}$/i;

/** A report's contents; null if it isn't a usable aggregate report. */
export function parseReport(xml: string): DmarcReport | null {
  if (xml.length > MAX_REPORT_BYTES) return null;
  const doc = section(xml.replace(/<!--[\s\S]*?-->/g, ''), 'feedback');
  if (!doc) return null;
  const meta = section(doc, 'report_metadata');
  const range = section(meta, 'date_range');
  const policy = section(doc, 'policy_published');
  const begin = Number(text(range, 'begin')) * 1000;
  const end = Number(text(range, 'end')) * 1000;
  const report: DmarcReport = {
    org: text(meta, 'org_name'),
    email: text(meta, 'email'),
    reportId: text(meta, 'report_id'),
    begin,
    end,
    domain: text(policy, 'domain', 253).toLowerCase().replace(/\.$/, ''),
    policy: word(text(policy, 'p')),
    subdomainPolicy: word(text(policy, 'sp')),
    pct: /^\d{1,3}$/.test(text(policy, 'pct')) ? Number(text(policy, 'pct')) : null,
    records: [],
  };
  if (!report.org || !report.reportId || !DOMAIN.test(report.domain)) return null;
  // Begin/end are seconds since 1970; a range that ends in the future (beyond clock skew) is made up.
  if (!Number.isFinite(begin) || !Number.isFinite(end) || begin <= 0 || end < begin || end > now() + 7 * DAY) return null;
  for (const m of doc.matchAll(tagRe('record', 'g'))) {
    if (report.records.length >= MAX_RECORDS) break;
    const row = section(m[1], 'row');
    const evaluated = section(row, 'policy_evaluated');
    const sourceIp = text(row, 'source_ip', 45);
    const count = Number(text(row, 'count'));
    if (!IP.test(sourceIp) || !Number.isInteger(count) || count < 0 || count > 1e9) continue;
    report.records.push({
      sourceIp,
      count,
      disposition: word(text(evaluated, 'disposition')),
      // The aligned results DMARC itself decided on (auth_results has the raw, unaligned ones).
      dkim: word(text(evaluated, 'dkim')),
      spf: word(text(evaluated, 'spf')),
      headerFrom: text(section(m[1], 'identifiers'), 'header_from', 253).toLowerCase(),
    });
  }
  return report;
}

// ── Storing ─────────────────────────────────────────────────────────────────

const passed = (r: DmarcRecord) => r.dkim === 'pass' || r.spf === 'pass';

/** The hosted domain a report is about (its own name, or a parent's for a subdomain). */
function hostedFor(domain: string): boolean {
  return hostedDomains().some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Save a report; reports re-sent by the same receiver (same org and report id) are kept once. */
export function storeReport(r: DmarcReport): 'stored' | 'duplicate' | 'ignored' {
  if (!hostedFor(r.domain)) return 'ignored';
  return tx(() => {
    if (get('SELECT 1 FROM dmarc_reports WHERE org = ? AND report_id = ?', [r.org, r.reportId])) return 'duplicate' as const;
    const total = r.records.reduce((n, x) => n + x.count, 0);
    const ok = r.records.filter(passed).reduce((n, x) => n + x.count, 0);
    const id = insert(
      `INSERT INTO dmarc_reports (org, email, report_id, domain, policy, subdomain_policy, pct, begin_at, end_at, messages, passed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.org, r.email, r.reportId, r.domain, r.policy, r.subdomainPolicy, r.pct, r.begin, r.end, total, ok, now()],
    );
    // One statement for every row (Durable Object SQLite caps bound parameters per statement).
    run(
      `INSERT INTO dmarc_records (report_id, source_ip, count, disposition, dkim, spf, header_from)
       SELECT ?, json_extract(value, '$.sourceIp'), json_extract(value, '$.count'), json_extract(value, '$.disposition'),
              json_extract(value, '$.dkim'), json_extract(value, '$.spf'), json_extract(value, '$.headerFrom')
         FROM json_each(?)`,
      [id, JSON.stringify(r.records)],
    );
    return 'stored' as const;
  });
}

/** Read and save any DMARC aggregate reports attached to an inbound message. Never throws. */
export async function readDmarcReports(p: Parsed): Promise<number> {
  let stored = 0;
  for (const a of p.attachments.filter(looksLikeReport).slice(0, MAX_ATTACHMENTS)) {
    try {
      const xml = await unpackReport(a.content);
      const report = xml ? parseReport(xml) : null;
      if (report && storeReport(report) === 'stored') stored++;
    } catch (err) {
      log.warn('Could not read DMARC report', err);
    }
  }
  return stored;
}

/** Drop reports past retention, with their rows. */
export function pruneDmarcReports(ts = now()) {
  const cutoff = ts - RETENTION_DAYS * DAY;
  run('DELETE FROM dmarc_records WHERE report_id IN (SELECT id FROM dmarc_reports WHERE end_at < ?)', [cutoff]);
  run('DELETE FROM dmarc_reports WHERE end_at < ?', [cutoff]);
}

// ── Summaries for admins ────────────────────────────────────────────────────

const rate = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : null);

/** Per domain over the last `days`: volume, pass rates, and the sources that fail most. */
export function dmarcSummary(days: number) {
  const since = now() - days * DAY;
  const rows = all<{ domain: string; reports: number; orgs: number; total: number; passed: number; dkim: number; spf: number; last: number; policy: string }>(
    `SELECT r.domain, COUNT(DISTINCT r.id) AS reports, COUNT(DISTINCT r.org) AS orgs, COALESCE(SUM(x.count), 0) AS total,
            COALESCE(SUM(CASE WHEN x.dkim = 'pass' OR x.spf = 'pass' THEN x.count END), 0) AS passed,
            COALESCE(SUM(CASE WHEN x.dkim = 'pass' THEN x.count END), 0) AS dkim,
            COALESCE(SUM(CASE WHEN x.spf = 'pass' THEN x.count END), 0) AS spf,
            MAX(r.end_at) AS last,
            (SELECT policy FROM dmarc_reports l WHERE l.domain = r.domain ORDER BY l.end_at DESC LIMIT 1) AS policy
       FROM dmarc_reports r LEFT JOIN dmarc_records x ON x.report_id = r.id
      WHERE r.end_at >= ? GROUP BY r.domain ORDER BY total DESC, r.domain`,
    [since],
  );
  return rows.map((d) => ({
    domain: d.domain,
    policy: d.policy,
    reports: d.reports,
    reporters: d.orgs,
    lastReportAt: d.last,
    total: d.total,
    passed: d.passed,
    failed: d.total - d.passed,
    passRate: rate(d.passed, d.total),
    dkimPassRate: rate(d.dkim, d.total),
    spfPassRate: rate(d.spf, d.total),
    failingSources: all<{ ip: string; count: number; header_from: string; dispositions: string; reporters: string }>(
      `SELECT x.source_ip AS ip, SUM(x.count) AS count, GROUP_CONCAT(DISTINCT x.header_from) AS header_from,
              GROUP_CONCAT(DISTINCT x.disposition) AS dispositions, GROUP_CONCAT(DISTINCT r.org) AS reporters
         FROM dmarc_records x JOIN dmarc_reports r ON r.id = x.report_id
        WHERE r.domain = ? AND r.end_at >= ? AND x.dkim != 'pass' AND x.spf != 'pass' AND x.count > 0
        GROUP BY x.source_ip ORDER BY count DESC, x.source_ip LIMIT 10`,
      [d.domain, since],
    ).map((s) => ({
      ip: s.ip,
      count: s.count,
      headerFrom: (s.header_from ?? '').split(',').filter(Boolean),
      dispositions: (s.dispositions ?? '').split(',').filter(Boolean),
      reporters: (s.reporters ?? '').split(',').filter(Boolean),
    })),
  }));
}

export interface DmarcReportRow {
  id: number;
  org: string;
  email: string;
  report_id: string;
  domain: string;
  policy: string;
  pct: number | null;
  begin_at: number;
  end_at: number;
  messages: number;
  passed: number;
  created_at: number;
}

/** Newest reports first, optionally for one domain, paged by id. */
export function listDmarcReports(opts: { domain?: string; before?: number | null; limit: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.domain) {
    where.push('domain = ?');
    params.push(opts.domain.toLowerCase());
  }
  if (opts.before) {
    where.push('id < ?');
    params.push(opts.before);
  }
  const rows = all<DmarcReportRow>(`SELECT * FROM dmarc_reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, [...params, opts.limit]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      org: r.org,
      email: r.email,
      reportId: r.report_id,
      domain: r.domain,
      policy: r.policy,
      pct: r.pct,
      begin: r.begin_at,
      end: r.end_at,
      messages: r.messages,
      passed: r.passed,
      passRate: rate(r.passed, r.messages),
      receivedAt: r.created_at,
    })),
    nextBefore: rows.length === opts.limit ? rows[rows.length - 1].id : null,
  };
}
