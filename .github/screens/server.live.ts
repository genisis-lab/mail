import fs from 'node:fs';
import http from 'node:http';
import { harness } from '../../tests/harness';
import { ingest } from '../../src/server/mail/ingest';
import { buildMime } from '../../src/server/mail/compose';
import { all, run } from '../../src/server/db/index';

const day = 86_400_000;
const at = (daysAgo: number, hour: number) => { const d = new Date(Date.now() - daysAgo * day); d.setHours(hour, 15, 0, 0); return d; };

it('serves Wren with sample mail', async () => {
  const h = harness();
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
  await h.call('PUT', '/api/admin/settings', { 'jmap.enabled': true });
  const key = (await h.call('POST', '/api/account/api-keys', { name: 'Mac', scope: 'mail' })).body.key;
  const mail = async (m: any) => {
    const { raw } = await buildMime({ to: [{ address: 'admin@wren.test', name: 'Ada Admin' }], ...m });
    await ingest(raw, { rcptTo: ['admin@wren.test'], source: 'test' });
  };
  await mail({ from: { address: 'alan@example.org', name: 'Alan Turing' }, subject: 'Quarterly numbers', date: at(9, 10), text: 'Hi Ada,\n\nThe quarterly numbers are in. Revenue is up 12% and churn is down. Full sheet attached.\n\nAlan' , attachments: [{ filename: 'Q3 numbers.csv', contentType: 'text/csv', content: Buffer.from('month,revenue\nJul,120\nAug,128\nSep,134\n') }] });
  await mail({ from: { address: 'news@weeklybyte.example', name: 'The Weekly Byte' }, subject: 'This week: variable fonts, explained', date: at(3, 7), html: '<div style="max-width:560px;margin:auto;font-family:Georgia,serif"><img src="https://weeklybyte.example/hero.png" width="560" height="200" alt="Hero"><h1 style="font-size:26px">Variable fonts, explained</h1><p>One file, every weight. This week we look at how variable fonts work, why they load faster, and how to use optical sizing on the web.</p><p><a href="https://weeklybyte.example/read">Read the full issue →</a></p></div>' });
  await mail({ from: { address: 'ada@lovelace.example', name: 'Ada Lovelace' }, subject: 'Notes on the Analytical Engine', date: at(2, 16), html: '<p>Dear Ada,</p><p>I have finished my notes on the engine. Note G has the algorithm for Bernoulli numbers; I would value your thoughts before I send it to Charles.</p><p>With warm regards,<br>Ada</p>', attachments: [{ filename: 'Note G.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 sample') }] });
  await mail({ from: { address: 'margaret@hamilton.example', name: 'Margaret Hamilton' }, subject: 'Launch checklist for Monday', date: at(1, 11), text: 'Here is the checklist for Monday. Please check items 4 and 7 before 9am.\n\n1. Freeze the release branch\n2. Run the full suite\n3. Tag the build\n4. Update the status page\n...' });
  await mail({ from: { address: 'grace@example.com', name: 'Grace Hopper' }, subject: 'Lunch on Friday?', date: at(0, 9), messageId: 'lunch-1@example.com', html: '<p>Hi Ada,</p><p>Are you free for lunch on Friday? There is a new place near the harbour that does excellent fish.</p><p>Grace</p>' });
  await mail({ from: { address: 'katherine@example.com', name: 'Katherine Johnson' }, cc: [{ address: 'grace@example.com', name: 'Grace Hopper' }], subject: 'Re: Lunch on Friday?', date: at(0, 10), inReplyTo: 'lunch-1@example.com', references: ['lunch-1@example.com'], html: '<p>Count me in! 12:30 works for me.</p><blockquote>Are you free for lunch on Friday? There is a new place near the harbour that does excellent fish.</blockquote><p>Katherine</p>' });
  // Read, flagged and labelled, so the list shows a mix.
  for (const r of all<{ id: number; subject: string }>('SELECT id, subject FROM messages')) {
    if (/Quarterly|Weekly|variable|Welcome/i.test(r.subject)) run('UPDATE messages SET is_read = 1 WHERE id = ?', [r.id]);
    if (/Launch/.test(r.subject)) run('UPDATE messages SET is_starred = 1 WHERE id = ?', [r.id]);
  }
  const jmap = (calls: any[]) => h.app.request('/jmap/api', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: calls }) });
  const acct = 'u1';
  await jmap([['Mailbox/set', { accountId: acct, create: { a: { name: 'Work' }, b: { name: 'Travel' } } }, '0']]);
  fs.writeFileSync('.github/screens/creds.json', JSON.stringify({ key }));
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const r = await h.app.request(req.url!, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body && (r.headers.get('content-type') ?? '').includes('event-stream')) {
      // Stream the push channel as it comes.
      const reader = r.body.getReader();
      req.on('close', () => reader.cancel().catch(() => {}));
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
      res.end();
      return;
    }
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(8787, '127.0.0.1', ok));
  await new Promise(() => {});
});
