/**
 * Gmail-style search query → SQL conditions over `messages m`.
 *
 * Supported: free text, "exact phrases", from: to: cc: bcc: subject: label:
 * has:attachment is:unread|read|starred|important|snoozed in:<folder>|anywhere
 * before: after: older_than: newer_than: larger: smaller: filename: and
 * negation with a leading "-".
 */

export interface SqlFragment {
  where: string[];
  params: unknown[];
  /** True when the query explicitly chose a folder (in:...), so callers skip default scoping. */
  scoped: boolean;
}

interface Token {
  key: string | null;
  value: string;
  negate: boolean;
}

export function tokenize(q: string): Token[] {
  const out: Token[] = [];
  const re = /(-)?(?:([a-z_]+):)?(?:"([^"]*)"|(\S+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const negate = !!m[1];
    const key = m[2]?.toLowerCase() ?? null;
    const value = m[3] ?? m[4] ?? '';
    if (!value && !key) continue;
    out.push({ key, value, negate });
  }
  return out;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function parseDate(v: string): number | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function parseRelative(v: string): number | null {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const day = 86_400_000;
  return n * (unit === 'd' ? day : unit === 'm' ? 30 * day : 365 * day);
}

function parseSize(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(v);
  if (!m) return null;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * mult);
}

/** Quote a term for FTS5 so user input can't inject operators. */
export function ftsTerm(word: string, prefix = true): string {
  const clean = word.replace(/"/g, '""').trim();
  if (!clean) return '';
  return `"${clean}"${prefix && !/\s/.test(clean) ? '*' : ''}`;
}

const FOLDERS = new Set(['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash']);

export function buildSearch(q: string, userId: number, now = Date.now()): SqlFragment {
  const where: string[] = [];
  const params: unknown[] = [];
  const positive: string[] = [];
  let scoped = false;

  const cond = (sql: string, negate: boolean, ...p: unknown[]) => {
    where.push(negate ? `NOT (${sql})` : sql);
    params.push(...p);
  };

  // Bounded so a query stays well under SQLite's bound-parameter limit (100 on Durable Objects).
  for (const t of tokenize(q).slice(0, 24)) {
    const v = t.value;
    switch (t.key) {
      case 'from':
        cond(`(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')`, t.negate, like(v), like(v));
        break;
      case 'to':
        cond(`(m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\' OR m.bcc_json LIKE ? ESCAPE '\\')`, t.negate, like(v), like(v), like(v));
        break;
      case 'cc':
        cond(`m.cc_json LIKE ? ESCAPE '\\'`, t.negate, like(v));
        break;
      case 'bcc':
        cond(`m.bcc_json LIKE ? ESCAPE '\\'`, t.negate, like(v));
        break;
      case 'subject':
        cond(`m.subject LIKE ? ESCAPE '\\'`, t.negate, like(v));
        break;
      case 'label':
        cond(
          `EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND l.user_id = ? AND lower(l.name) = lower(?))`,
          t.negate,
          userId,
          v,
        );
        break;
      case 'has':
        if (/^attachments?$/i.test(v)) cond('m.has_attachments = 1', t.negate);
        else if (/^(user)?labels?$/i.test(v)) cond('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id)', t.negate);
        break;
      case 'filename':
        cond(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.filename LIKE ? ESCAPE '\\')`, t.negate, like(v));
        break;
      case 'is':
        switch (v.toLowerCase()) {
          case 'unread':
            cond('m.is_read = 0', t.negate);
            break;
          case 'read':
            cond('m.is_read = 1', t.negate);
            break;
          case 'starred':
            cond('m.is_starred = 1', t.negate);
            break;
          case 'important':
            cond('m.is_important = 1', t.negate);
            break;
          case 'snoozed':
            cond('m.snoozed_until > ?', t.negate, now);
            break;
        }
        break;
      case 'in': {
        const f = v.toLowerCase();
        if (f === 'anywhere' || f === 'all') {
          scoped = true;
        } else if (FOLDERS.has(f)) {
          scoped = true;
          cond('m.folder = ?', t.negate, f);
        }
        break;
      }
      case 'before':
      case 'after': {
        const d = parseDate(v);
        if (d !== null) cond(t.key === 'before' ? 'm.date < ?' : 'm.date >= ?', t.negate, d);
        break;
      }
      case 'older_than':
      case 'newer_than': {
        const ms = parseRelative(v);
        if (ms !== null) cond(t.key === 'older_than' ? 'm.date < ?' : 'm.date >= ?', t.negate, now - ms);
        break;
      }
      case 'larger':
      case 'smaller': {
        const size = parseSize(v);
        if (size !== null) cond(t.key === 'larger' ? 'm.size > ?' : 'm.size < ?', t.negate, size);
        break;
      }
      default: {
        // Unknown "key:value" is treated as text; plain words go to FTS.
        const text = t.key ? `${t.key}:${v}` : v;
        const term = ftsTerm(text.replace(/[:]/g, ' '), !text.includes(' '));
        if (!term) break;
        if (t.negate) cond('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)', true, term);
        else positive.push(term);
      }
    }
  }
  if (positive.length) {
    where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
    params.push(positive.join(' '));
  }
  return { where, params, scoped };
}
