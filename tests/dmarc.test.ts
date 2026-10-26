import { gzipSync, deflateRawSync, crc32 } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { all, get } from '../src/server/db/index';
import { buildMime } from '../src/server/mail/compose';
import { ingest } from '../src/server/mail/ingest';
import { parseReport, unpackReport } from '../src/server/mail/dmarc';
import { runMaintenance } from '../src/server/jobs';
import { harness } from './harness';

const h = harness();
const DAY = 86_400;

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', 'a very long password', 'admin');
});

function reportXml(opts: { org: string; id: string; domain?: string; endDaysAgo?: number; records: [ip: string, count: number, dkim: string, spf: string][] }) {
  const end = Math.floor(Date.now() / 1000) - (opts.endDaysAgo ?? 1) * DAY;
  const rows = opts.records
    .map(
      ([ip, count, dkim, spf]) => `
    <record>
      <row>
        <source_ip>${ip}</source_ip>
        <count>${count}</count>
        <policy_evaluated><disposition>${dkim === 'pass' || spf === 'pass' ? 'none' : 'quarantine'}</disposition><dkim>${dkim}</dkim><spf>${spf}</spf></policy_evaluated>
      </row>
      <identifiers><header_from>${opts.domain ?? 'wren.test'}</header_from></identifiers>
      <auth_results><dkim><domain>other.example</domain><result>pass</result></dkim><spf><domain>x</domain><result>pass</result></spf></auth_results>
    </record>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE feedback [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">
  <report_metadata>
    <org_name>${opts.org}</org_name>
    <email>noreply-dmarc-support@${opts.org}</email>
    <report_id>${opts.id}</report_id>
    <date_range><begin>${end - DAY}</begin><end>${end}</end></date_range>
  </report_metadata>
  <policy_published><domain>${opts.domain ?? 'wren.test'}</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><sp>quarantine</sp><pct>100</pct></policy_published>
  ${rows}
</feedback>`;
}

/** A one-file zip archive, deflated (what Microsoft and others send). */
function zip(name: string, data: Buffer): Buffer {
  const body = deflateRawSync(data);
  const fname = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + fname.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + fname.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, fname, body, central, fname, eocd]);
}

async function deliver(rcpt: string, filename: string, contentType: string, content: Buffer) {
  const { raw } = await buildMime({
    from: { address: 'noreply-dmarc-support@google.com' },
    to: [{ address: rcpt }],
    subject: `Report Domain: wren.test Submitter: google.com`,
    text: 'This is an aggregate report from google.com.',
    attachments: [{ filename, contentType, content }],
  });
  return ingest(raw, { rcptTo: [rcpt], mailFrom: 'noreply-dmarc-support@google.com', source: 'smtp', skipSpam: true });
}

describe('DMARC aggregate reports', () => {
  it('reads a gzipped report sent to postmaster@, even with no mailbox there', async () => {
    const xml = reportXml({
      org: 'google.com',
      id: 'g-1',
      records: [
        ['203.0.113.5', 40, 'pass', 'pass'],
        ['198.51.100.7', 6, 'fail', 'fail'],
        ['192.0.2.1', 4, 'pass', 'fail'],
      ],
    });
    const res = await deliver('postmaster@wren.test', 'google.com!wren.test!1!2.xml.gz', 'application/gzip', gzipSync(xml));
    expect(res.delivered).toBe(0); // nobody is postmaster@ here, so the message itself is refused as usual
    const r = get<any>(`SELECT * FROM dmarc_reports WHERE report_id = 'g-1'`)!;
    expect(r).toMatchObject({ org: 'google.com', domain: 'wren.test', policy: 'quarantine', pct: 100, messages: 50, passed: 44 });
    expect(r.end_at - r.begin_at).toBe(DAY * 1000);
    const rows = all<any>('SELECT source_ip, count, disposition, dkim, spf, header_from FROM dmarc_records WHERE report_id = ? ORDER BY count DESC', [r.id]);
    expect(rows).toEqual([
      { source_ip: '203.0.113.5', count: 40, disposition: 'none', dkim: 'pass', spf: 'pass', header_from: 'wren.test' },
      { source_ip: '198.51.100.7', count: 6, disposition: 'quarantine', dkim: 'fail', spf: 'fail', header_from: 'wren.test' },
      { source_ip: '192.0.2.1', count: 4, disposition: 'none', dkim: 'pass', spf: 'fail', header_from: 'wren.test' },
    ]);
  });

  it('reads a zipped report and still delivers the mail', async () => {
    const xml = reportXml({ org: 'enterprise.protection.outlook.com', id: 'ms-1', records: [['198.51.100.7', 3, 'fail', 'fail'], ['203.0.113.5', 7, 'pass', 'fail']] });
    const res = await deliver('admin@wren.test', 'enterprise.protection.outlook.com!wren.test!1!2.zip', 'application/zip', zip('report.xml', Buffer.from(xml)));
    expect(res.delivered).toBe(1);
    expect(get(`SELECT 1 FROM messages WHERE subject LIKE 'Report Domain:%' AND direction = 'in'`)).toBeTruthy();
    expect(get<any>(`SELECT messages, passed FROM dmarc_reports WHERE report_id = 'ms-1'`)).toEqual({ messages: 10, passed: 7 });
  });

  it('keeps a report sent twice once', async () => {
    const xml = gzipSync(reportXml({ org: 'google.com', id: 'g-1', records: [['203.0.113.5', 99, 'pass', 'pass']] }));
    await deliver('postmaster@wren.test', 'again.xml.gz', 'application/gzip', xml);
    expect(all(`SELECT 1 FROM dmarc_reports WHERE org = 'google.com' AND report_id = 'g-1'`)).toHaveLength(1);
    expect(get<any>(`SELECT messages FROM dmarc_reports WHERE report_id = 'g-1'`).messages).toBe(50);
  });

  it('ignores reports about other domains, junk, and archives that unpack too big', async () => {
    await deliver('postmaster@wren.test', 'x.xml.gz', 'application/gzip', gzipSync(reportXml({ org: 'evil.example', id: 'e-1', domain: 'not-hosted.example', records: [['1.2.3.4', 1, 'fail', 'fail']] })));
    await deliver('postmaster@wren.test', 'x.gz', 'application/gzip', Buffer.from('not gzip at all'));
    expect(get(`SELECT 1 FROM dmarc_reports WHERE org = 'evil.example'`)).toBeUndefined();
    const bomb = gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x20));
    expect(await unpackReport(bomb)).toBeNull();
    expect(await unpackReport(zip('r.xml', Buffer.alloc(6 * 1024 * 1024, 0x20)))).toBeNull();
    expect(parseReport('<feedback><report_metadata><org_name>a</org_name></report_metadata></feedback>')).toBeNull();
  });

  it('summarises pass rates and failing sources for admins only', async () => {
    const res = await h.call('GET', '/api/admin/dmarc?days=30');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    const d = res.body.domains.find((x: any) => x.domain === 'wren.test');
    expect(d).toMatchObject({ reports: 2, reporters: 2, total: 60, passed: 51, failed: 9, passRate: 85, policy: 'quarantine' });
    expect(d.failingSources).toEqual([{ ip: '198.51.100.7', count: 9, headerFrom: ['wren.test'], dispositions: ['quarantine'], reporters: expect.arrayContaining(['google.com', 'enterprise.protection.outlook.com']) }]);

    const list = await h.call('GET', '/api/admin/dmarc/reports?domain=wren.test');
    expect(list.body.items.map((r: any) => r.reportId)).toEqual(['ms-1', 'g-1']);
    expect(list.body.items[1]).toMatchObject({ org: 'google.com', messages: 50, passRate: 88 });

    await h.call('POST', '/api/admin/users', { email: 'dora@wren.test', name: 'Dora', password: 'dora password 123' });
    await h.login('dora@wren.test', 'dora password 123', 'dora');
    expect((await h.call('GET', '/api/admin/dmarc')).status).toBe(403);
    expect((await h.call('GET', '/api/admin/dmarc/reports')).status).toBe(403);
    h.as('admin');
  });

  it('drops reports older than 180 days', async () => {
    await deliver('postmaster@wren.test', 'old.xml', 'text/xml', Buffer.from(reportXml({ org: 'yahoo.com', id: 'old-1', endDaysAgo: 181, records: [['192.0.2.9', 2, 'pass', 'pass']] })));
    const old = get<{ id: number }>(`SELECT id FROM dmarc_reports WHERE report_id = 'old-1'`)!;
    expect(old).toBeTruthy();
    expect((await h.call('GET', '/api/admin/dmarc?days=30')).body.domains[0].reports).toBe(2);
    runMaintenance();
    expect(get(`SELECT 1 FROM dmarc_reports WHERE report_id = 'old-1'`)).toBeUndefined();
    expect(get('SELECT 1 FROM dmarc_records WHERE report_id = ?', [old.id])).toBeUndefined();
    expect(get(`SELECT 1 FROM dmarc_reports WHERE report_id = 'g-1'`)).toBeTruthy();
  });
});
