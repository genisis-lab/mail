import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { all, get } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { decodeMailboxName, ImapConnection, ImapError, parseImapDate } from '../src/server/mail/imap-client';
import { optionsFromHeaders, planFolders, splitLabels, startImapImport } from '../src/server/services/mail-import';
import { runJobs } from '../src/server/services/jobs';
import { MboxSplitter } from '../src/shared/mbox';
import { harness } from './harness';

const h = harness();

// ── A tiny IMAP server ──────────────────────────────────────────────────────

interface FakeMessage {
  uid: number;
  flags: string;
  raw: string;
}

const enc = new TextEncoder();

async function message(id: string, opts: { from?: string; to?: string; subject: string; body?: string }) {
  const { raw } = await buildMime({
    from: { address: opts.from ?? 'sam@example.org', name: 'Sam' },
    to: [{ address: opts.to ?? 'ivy@gmail.example' }],
    subject: opts.subject,
    text: opts.body ?? `About ${opts.subject}`,
    messageId: `<${id}@example.org>`,
  });
  return raw.toString('utf8');
}

function startImap(boxes: Record<string, { flags: string; literal?: boolean; messages: FakeMessage[] }>, auth: { sasl: boolean }) {
  const server = net.createServer((sock) => {
    let buf = '';
    let pendingAuth: string | null = null;
    let selected: string | null = null;
    const send = (s: string) => sock.write(s);
    const ok = (tag: string, text = 'done') => send(`${tag} OK ${text}\r\n`);
    const caps = auth.sasl ? 'IMAP4rev1 AUTH=PLAIN SASL-IR' : 'IMAP4rev1 LOGINDISABLED-NOT';
    send(`* OK [CAPABILITY ${caps}] Fake IMAP ready\r\n`);
    const check = (tag: string, user: string, pass: string) => {
      if (user === 'ivy@gmail.example' && pass === 'app pässword') ok(tag, '[CAPABILITY IMAP4rev1] signed in');
      else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
    };
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (pendingAuth) {
          const [, user, pass] = Buffer.from(line, 'base64').toString('utf8').split('\0');
          check(pendingAuth, user, pass);
          pendingAuth = null;
          continue;
        }
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        const upper = cmd.toUpperCase();
        if (upper === 'CAPABILITY') {
          send(`* CAPABILITY ${caps}\r\n`);
          ok(tag);
        } else if (upper.startsWith('AUTHENTICATE PLAIN')) {
          const ir = cmd.split(' ')[2];
          if (ir) {
            const [, user, pass] = Buffer.from(ir, 'base64').toString('utf8').split('\0');
            check(tag, user, pass);
          } else {
            pendingAuth = tag;
            send('+ \r\n');
          }
        } else if (upper.startsWith('LOGIN ')) {
          const m = /^LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/i.exec(cmd)!;
          check(tag, m[1].replace(/\\(.)/g, '$1'), m[2].replace(/\\(.)/g, '$1'));
        } else if (upper === 'LIST "" "*"') {
          for (const [name, box] of Object.entries(boxes)) {
            if (box.literal) send(`* LIST (${box.flags}) "/" {${Buffer.byteLength(name)}}\r\n${name}\r\n`);
            else send(`* LIST (${box.flags}) "/" "${name}"\r\n`);
          }
          ok(tag);
        } else if (upper.startsWith('STATUS ')) {
          const name = /^STATUS "(.*)" \(/i.exec(cmd)![1];
          const box = boxes[name];
          send(`* STATUS "${name}" (MESSAGES ${box.messages.length} UIDNEXT ${box.messages.length + 1} UIDVALIDITY 7)\r\n`);
          ok(tag);
        } else if (upper.startsWith('EXAMINE ')) {
          selected = /^EXAMINE "(.*)"$/i.exec(cmd)![1];
          const box = boxes[selected];
          if (!box) {
            send(`${tag} NO no such mailbox\r\n`);
            continue;
          }
          send(`* ${box.messages.length} EXISTS\r\n* OK [UIDVALIDITY 7] UIDs valid\r\n`);
          ok(tag, '[READ-ONLY] EXAMINE completed');
        } else if (upper.startsWith('UID SEARCH UID ')) {
          const from = Number(/UID (\d+):\*/i.exec(cmd)![1]);
          const uids = boxes[selected!].messages.map((m) => m.uid);
          // Real servers include the highest UID even when it is below the range start.
          const hits = uids.filter((u) => u >= from);
          if (!hits.length && uids.length) hits.push(Math.max(...uids));
          send(`* SEARCH ${hits.join(' ')}\r\n`);
          ok(tag);
        } else if (upper.startsWith('UID FETCH ')) {
          const want = new Set(cmd.split(' ')[2].split(',').map(Number));
          boxes[selected!].messages.forEach((m, i) => {
            if (!want.has(m.uid)) return;
            const raw = Buffer.from(m.raw, 'utf8');
            // Alternate the order of the items, as servers do.
            if (i % 2 === 0) send(`* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.flags}) INTERNALDATE "17-Jul-2024 02:44:25 -0700" BODY[] {${raw.length}}\r\n`);
            else send(`* ${i + 1} FETCH (FLAGS (${m.flags}) BODY[] {${raw.length}}\r\n`);
            sock.write(raw);
            send(i % 2 === 0 ? ')\r\n' : ` UID ${m.uid} INTERNALDATE "17-Jul-2024 02:44:25 -0700")\r\n`);
          });
          ok(tag);
        } else if (upper === 'LOGOUT') {
          send('* BYE\r\n');
          ok(tag);
          sock.end();
        } else {
          send(`${tag} BAD unknown command\r\n`);
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

let gmail: Awaited<ReturnType<typeof startImap>>;
let loginOnly: Awaited<ReturnType<typeof startImap>>;

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  await h.call('POST', '/api/admin/users', { email: 'ivy@wren.test', name: 'Ivy', password: 'ivy password 123' });
  await h.call('POST', '/api/admin/users', { email: 'otto@wren.test', name: 'Otto', password: 'otto password 123' });
  await h.login('ivy@wren.test', 'ivy password 123', 'ivy');
  await h.login('otto@wren.test', 'otto password 123', 'otto');

  const a = await message('a', { subject: 'Read in inbox' });
  const b = await message('b', { subject: 'Unread in inbox' });
  const c = await message('c', { subject: 'Your receipt' });
  const d = await message('d', { from: 'ivy@gmail.example', to: 'sam@example.org', subject: 'I sent this' });
  const e = await message('e', { subject: 'Thrown away' });
  const f = await message('f', { subject: 'CV attached', body: 'From the top:\r\nmy CV' });
  gmail = await startImap(
    {
      INBOX: { flags: '\\HasNoChildren', messages: [{ uid: 1, flags: '\\Seen', raw: a }, { uid: 4, flags: '', raw: b }] },
      '[Gmail]': { flags: '\\HasChildren \\Noselect', messages: [] },
      '[Gmail]/All Mail': {
        flags: '\\All \\HasNoChildren',
        messages: [
          { uid: 1, flags: '\\Seen', raw: a },
          { uid: 2, flags: '', raw: b },
          { uid: 3, flags: '\\Seen \\Flagged', raw: c },
          { uid: 5, flags: '\\Seen', raw: f },
        ],
      },
      '[Gmail]/Sent Mail': { flags: '\\HasNoChildren \\Sent', messages: [{ uid: 9, flags: '\\Seen', raw: d }] },
      '[Gmail]/Drafts': { flags: '\\Drafts \\HasNoChildren', messages: [{ uid: 1, flags: '', raw: await message('draft', { subject: 'Draft' }) }] },
      '[Gmail]/Starred': { flags: '\\Flagged \\HasNoChildren', messages: [{ uid: 3, flags: '\\Seen \\Flagged', raw: c }] },
      '[Gmail]/Trash': { flags: '\\HasNoChildren \\Trash', messages: [{ uid: 2, flags: '\\Seen', raw: e }] },
      Receipts: { flags: '\\HasNoChildren', messages: [{ uid: 1, flags: '\\Seen \\Flagged', raw: c }] },
      'Work/R&AOk-sum&AOk-': { flags: '\\HasNoChildren', literal: true, messages: [{ uid: 1, flags: '\\Seen', raw: f }] },
    },
    { sasl: true },
  );
  loginOnly = await startImap({ INBOX: { flags: '', messages: [] } }, { sasl: false });
});

afterAll(async () => {
  await gmail.close();
  await loginOnly.close();
});

const opts = (port: number, password = 'app pässword') => ({ host: '127.0.0.1', port, security: 'none' as const, username: 'ivy@gmail.example', password, timeoutMs: 5000 });

describe('IMAP client', () => {
  it('signs in, lists folders (with literals) and fetches by UID', async () => {
    const conn = await ImapConnection.open(opts(gmail.port));
    const boxes = await conn.list();
    expect(boxes.map((b) => b.display)).toContain('Work/Résumé');
    expect(boxes.find((b) => b.name === '[Gmail]/Sent Mail')?.flags).toContain('\\Sent');
    expect((await conn.select('[Gmail]/All Mail')).exists).toBe(4);
    expect(await conn.uidsAfter(0)).toEqual([1, 2, 3, 5]);
    expect(await conn.uidsAfter(5)).toEqual([]); // the server's "highest UID" quirk is ignored
    const fetched = await conn.fetch([2, 3]);
    expect(fetched.map((m) => [m.uid, m.flags])).toEqual([
      [2, []],
      [3, ['\\Seen', '\\Flagged']],
    ]);
    expect(new TextDecoder().decode(fetched[1].raw)).toContain('Subject: Your receipt');
    expect(fetched[0].internalDate).toBe(Date.UTC(2024, 6, 17, 9, 44, 25));
    await conn.close();
  });

  it('reports a wrong password as a sign-in failure', async () => {
    const err = await ImapConnection.open(opts(gmail.port, 'nope')).catch((e) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect(err.authFailed).toBe(true);
    expect(err.permanent).toBe(true);
    expect(err.message).toMatch(/Invalid credentials/);
    // LOGIN is used when the server offers no AUTH=PLAIN, and the password never appears in errors.
    const login = await ImapConnection.open(opts(loginOnly.port, 'wrong "quoted" pass')).catch((e) => e);
    expect(login.authFailed).toBe(true);
    expect(login.message).not.toContain('quoted');
    // A non-ASCII password can't go through LOGIN, so the client uses AUTHENTICATE PLAIN (UTF-8) instead.
    const ok = await ImapConnection.open(opts(loginOnly.port));
    expect(await ok.list()).toHaveLength(1);
    await ok.close();
  });

  it('decodes names and dates', () => {
    expect(decodeMailboxName('&ZeVnLIqe-')).toBe('日本語');
    expect(decodeMailboxName('Tom &- Jerry')).toBe('Tom & Jerry');
    expect(parseImapDate(' 1-Feb-2024 00:00:00 +0100')).toBe(Date.UTC(2024, 0, 31, 23, 0, 0));
    expect(parseImapDate('nonsense')).toBeNull();
  });
});

describe('folder plan and Gmail labels', () => {
  it('maps IMAP folders onto Wren folders and labels', () => {
    const plan = planFolders([
      { name: '[Gmail]/All Mail', display: '[Gmail]/All Mail', flags: ['\\All'], delimiter: '/' },
      { name: 'Projects/2024', display: 'Projects/2024', flags: [], delimiter: '/' },
      { name: 'INBOX', display: 'INBOX', flags: [], delimiter: '/' },
      { name: 'Junk', display: 'Junk', flags: [], delimiter: '/' },
      { name: 'INBOX.Clients', display: 'INBOX.Clients', flags: [], delimiter: '.' },
      { name: 'Sent Items', display: 'Sent Items', flags: [], delimiter: '/' },
      { name: '[Gmail]/Important', display: '[Gmail]/Important', flags: ['\\Important'], delimiter: '/' },
      { name: '[Gmail]', display: '[Gmail]', flags: ['\\Noselect'], delimiter: '/' },
    ]);
    expect(plan.map((p) => [p.name, p.folder, p.label])).toEqual([
      ['INBOX', 'inbox', null],
      ['Sent Items', 'sent', null],
      ['Projects/2024', 'archive', 'Projects/2024'],
      ['INBOX.Clients', 'archive', 'Clients'],
      ['[Gmail]/All Mail', 'archive', null],
      ['Junk', 'spam', null],
    ]);
  });

  it('reads Takeout labels', () => {
    expect(splitLabels('Inbox,Important,"Work, 2024",Category Updates')).toEqual(['Inbox', 'Important', 'Work, 2024', 'Category Updates']);
    expect(optionsFromHeaders({ gmail: 'Inbox,Unread,Important,"Work, 2024",Category Updates' })).toEqual({
      folder: 'inbox',
      read: false,
      starred: false,
      important: true,
      labels: ['Work, 2024'],
    });
    expect(optionsFromHeaders({ gmail: 'Archived,Opened,Starred,Receipts' })).toMatchObject({ folder: 'archive', read: true, starred: true, labels: ['Receipts'] });
    expect(optionsFromHeaders({ gmail: 'Sent' })).toMatchObject({ folder: 'sent' });
    expect(optionsFromHeaders({ gmail: 'Chat' })).toBeNull();
    expect(optionsFromHeaders({ gmail: 'Drafts' })).toBeNull();
    expect(optionsFromHeaders({ wrenFolder: 'spam', wrenFlags: 'starred', wrenLabels: 'A, "B, C"' })).toEqual({ folder: 'spam', read: false, starred: true, important: false, labels: ['A', 'B, C'] });
  });
});

async function runUntilDone(jobId: number) {
  for (let i = 0; i < 50; i++) {
    const row = get<{ status: string; next_run_at: number }>('SELECT status, next_run_at FROM jobs WHERE id = ?', [jobId])!;
    if (!['queued', 'running'].includes(row.status)) return;
    // Make the job due now, then run a slice.
    (await import('../src/server/db/index')).run('UPDATE jobs SET next_run_at = 0 WHERE id = ?', [jobId]);
    await runJobs();
  }
  throw new Error('job did not finish');
}

describe('IMAP import', () => {
  it('copies every folder once, with labels, flags and folders preserved, then forgets the password', async () => {
    const ivy = get<{ id: number }>(`SELECT id FROM users WHERE email = 'ivy@wren.test'`)!.id;
    const jobId = await startImapImport(ivy, opts(gmail.port));
    expect(get<{ config: string }>('SELECT config FROM jobs WHERE id = ?', [jobId])!.config).not.toContain('pässword'); // encrypted at rest
    await expect(startImapImport(ivy, opts(gmail.port))).rejects.toThrow(/already running/);
    await runUntilDone(jobId);

    h.as('ivy');
    const jobs = (await h.call('GET', '/api/me/jobs')).body.jobs;
    expect(jobs[0]).toMatchObject({ kind: 'imap_import', status: 'done', progress: { imported: 6, duplicates: 4, failed: 0, folders: 6, account: 'ivy@gmail.example (127.0.0.1)' } });
    expect(get<{ config: string | null }>('SELECT config FROM jobs WHERE id = ?', [jobId])!.config).toBeNull();

    const rows = all<any>(
      `SELECT m.subject, m.folder, m.is_read, m.is_starred, m.direction, m.source,
              (SELECT group_concat(l.name) FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id) AS labels
         FROM messages m WHERE m.user_id = ? AND m.source = 'import' ORDER BY m.subject`,
      [ivy],
    );
    expect(rows).toEqual([
      { subject: 'CV attached', folder: 'archive', is_read: 1, is_starred: 0, direction: 'in', source: 'import', labels: 'Work/Résumé' },
      { subject: 'I sent this', folder: 'sent', is_read: 1, is_starred: 0, direction: 'out', source: 'import', labels: null },
      { subject: 'Read in inbox', folder: 'inbox', is_read: 1, is_starred: 0, direction: 'in', source: 'import', labels: null },
      { subject: 'Thrown away', folder: 'trash', is_read: 1, is_starred: 0, direction: 'in', source: 'import', labels: null },
      { subject: 'Unread in inbox', folder: 'inbox', is_read: 0, is_starred: 0, direction: 'in', source: 'import', labels: null },
      { subject: 'Your receipt', folder: 'archive', is_read: 1, is_starred: 1, direction: 'in', source: 'import', labels: 'Receipts' },
    ]);
    // Imported mail is searchable and doesn't trigger new-mail notifications.
    expect((await h.call('GET', '/api/mail/threads?q=receipt')).body.threads).toHaveLength(1);
    expect((await h.call('GET', '/api/me/notifications')).body.items.map((i: any) => i.subject)).not.toContain('Unread in inbox');

    // Running it again copies nothing new.
    const again = await startImapImport(ivy, opts(gmail.port));
    await runUntilDone(again);
    expect((await h.call('GET', '/api/me/jobs')).body.jobs[0].progress).toMatchObject({ imported: 0, duplicates: 10 });
  });

  it('checks the server before starting and refuses private hosts', async () => {
    h.as('ivy');
    const base = { port: 993, security: 'tls', username: 'ivy@gmail.example', password: 'x' };
    for (const host of ['127.0.0.1', 'localhost', 'imap.corp.internal', 'printer.local']) {
      const r = await h.call('POST', '/api/me/import/imap', { ...base, host });
      expect(r.status, host).toBe(400);
      expect(r.body.error).toMatch(/server name/);
    }
    expect((await h.call('POST', '/api/me/import/imap', { ...base, host: 'imap.gmail.com', port: 25 })).body.error).toMatch(/993/);
  });

  it('cancels a running import and forgets its password', async () => {
    const otto = get<{ id: number }>(`SELECT id FROM users WHERE email = 'otto@wren.test'`)!.id;
    const jobId = await startImapImport(otto, opts(gmail.port));
    h.as('ivy');
    expect((await h.call('POST', `/api/me/jobs/${jobId}/cancel`)).status).toBe(404); // not hers
    h.as('otto');
    expect((await h.call('POST', `/api/me/jobs/${jobId}/cancel`)).status).toBe(200);
    expect(get<any>('SELECT status, config FROM jobs WHERE id = ?', [jobId])).toEqual({ status: 'cancelled', config: null });
    await runJobs();
    expect(get<{ c: number }>(`SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND source = 'import'`, [otto])!.c).toBe(0);
    expect((await h.call('DELETE', `/api/me/jobs/${jobId}`)).status).toBe(200);
  });
});

describe('mbox', () => {
  it('splits files in any chunking and undoes From-quoting', () => {
    const file =
      'From alice@example.org Mon Jan  1 00:00:00 2024\nSubject: one\n\nHello\n>From the start\n>>From deeper\n\n' +
      'From bob@example.org Tue Jan  2 00:00:00 2024\r\nSubject: two\r\n\r\n>From here on\r\n\r\n' +
      'From carol@example.org Wed Jan  3 00:00:00 2024\nSubject: three\n\nBye\n';
    const bytes = enc.encode(file);
    const expected = ['Subject: one\n\nHello\nFrom the start\n>From deeper\n', 'Subject: two\r\n\r\nFrom here on\r\n', 'Subject: three\n\nBye\n'];
    for (const size of [1, 3, 7, 64, bytes.length]) {
      const s = new MboxSplitter();
      const out: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) out.push(...s.push(bytes.subarray(i, i + size)));
      out.push(...s.end());
      expect(out.map((m) => new TextDecoder().decode(m)), `chunk ${size}`).toEqual(expected);
    }
    const junk = new MboxSplitter();
    expect([...junk.push(enc.encode('not an mbox at all\nreally\n')), ...junk.end()]).toEqual([]);
    expect(junk.junk).toBeGreaterThan(0);
  });

  it('exports everything and imports it back with folders, labels and flags, without duplicates', async () => {
    h.as('admin');
    const { raw } = await buildMime({ from: { address: 'kim@example.org', name: 'Kim' }, to: [{ address: 'admin@wren.test' }], subject: 'Quarterly plan', text: 'From now on we plan quarterly.\nFrom: not a header' });
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'cloudflare-routing' });
    const thread = (await h.call('GET', '/api/mail/threads?q=quarterly')).body.threads[0];
    const label = (await h.call('POST', '/api/labels', { name: 'Plans, 2025', color: '#22c55e' })).body;
    expect((await h.call('POST', '/api/mail/threads/actions', { threadIds: [thread.id], action: { type: 'label', labelId: label.id } })).status).toBe(200);
    expect((await h.call('POST', '/api/mail/threads/actions', { threadIds: [thread.id], action: { type: 'star' } })).status).toBe(200);
    expect((await h.call('POST', '/api/compose/send', { to: [{ address: 'kim@example.org' }], subject: 'Re: Quarterly plan', html: '<p>Sounds good</p>' })).status).toBe(200);

    const start = await h.call('POST', '/api/me/export');
    expect(start.status).toBe(200);
    expect((await h.call('POST', '/api/me/export')).body.error).toMatch(/already running/);
    expect((await h.call('GET', `/api/me/export/${start.body.job.id}/download`)).status).toBe(409);
    await runUntilDone(start.body.job.id);
    const job = (await h.call('GET', '/api/me/jobs')).body.jobs[0];
    expect(job).toMatchObject({ kind: 'export', status: 'done', error: null });
    const admin = get<{ id: number }>(`SELECT id FROM users WHERE email = 'admin@wren.test'`)!.id;
    const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?', [admin])!.c;
    expect(job.progress.messages).toBe(count);

    const res = await h.request(`/api/me/export/${job.id}/download`);
    expect(res.headers.get('content-type')).toBe('application/mbox');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="wren-mail-\d{4}-\d{2}-\d{2}\.mbox"/);
    const file = new Uint8Array(await res.arrayBuffer());
    expect(String(file.length)).toBe(res.headers.get('content-length'));
    const text = new TextDecoder('latin1').decode(file);
    expect(text).toContain('\n>From now on we plan quarterly.');
    expect(text).toMatch(/X-Wren-Folder: inbox\nX-Wren-Flags: starred\nX-Wren-Labels: "Plans, 2025"\n/);

    // Import it into Otto's mailbox the way the browser does: split, then upload in batches.
    const splitter = new MboxSplitter();
    const messages = [...splitter.push(file), ...splitter.end()];
    expect(messages.length).toBe(count);
    h.as('otto');
    const b64 = messages.map((m) => Buffer.from(m).toString('base64'));
    const first = (await h.call('POST', '/api/me/import/messages', { messages: b64 })).body;
    expect(first.failed).toBe(0);
    expect(first.imported + first.skipped).toBe(count); // drafts are skipped
    const second = (await h.call('POST', '/api/me/import/messages', { messages: b64 })).body;
    expect(second).toMatchObject({ imported: 0, duplicates: first.imported });

    const otto = get<{ id: number }>(`SELECT id FROM users WHERE email = 'otto@wren.test'`)!.id;
    const plan = get<any>(
      `SELECT m.folder, m.text_body, m.is_read, m.is_starred, (SELECT group_concat(l.name) FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id) AS labels
         FROM messages m WHERE m.user_id = ? AND m.subject = 'Quarterly plan'`,
      [otto],
    );
    expect(plan).toMatchObject({ folder: 'inbox', labels: 'Plans, 2025', is_read: 0, is_starred: 1 });
    expect(plan.text_body).toContain('From now on we plan quarterly.');
    expect(get<any>(`SELECT folder, direction FROM messages WHERE user_id = ? AND subject = 'Re: Quarterly plan'`, [otto])).toEqual({ folder: 'sent', direction: 'out' });

    // Deleting the export removes its files.
    expect((await h.call('DELETE', `/api/me/jobs/${job.id}`)).status).toBe(404); // Otto can't
    h.as('admin');
    expect((await h.call('DELETE', `/api/me/jobs/${job.id}`)).status).toBe(200);
  });

  it('rejects oversized uploads', async () => {
    h.as('otto');
    const big = Buffer.alloc(13 * 1024 * 1024, 65).toString('base64');
    expect((await h.call('POST', '/api/me/import/messages', { messages: [big, big] })).body.error).toMatch(/24 MB/);
  });
});
