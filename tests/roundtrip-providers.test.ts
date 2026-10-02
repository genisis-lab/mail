/**
 * The admin "send a test to yourself" check must work whichever provider
 * sends the mail. Each provider is given the real test message; what it would
 * put on the wire must carry the test token (as the X-Wren-Roundtrip header,
 * or at least as the code in the body), and Wren must recognise the message
 * when it comes back either way.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/server/db/index';
import { invalidateSettings } from '../src/server/settings';
import { buildMime } from '../src/server/mail/compose';
import { toOutboundEmail } from '../src/server/mail/outbound';
import { parseMail, getHeader } from '../src/server/mail/parse';
import { getProviderDef, listProviderTypes } from '../src/server/providers/registry';
import type { ProviderContext } from '../src/server/providers/types';
import { platform, setPlatform } from '../src/server/platform';
import { roundtripToken } from '../src/server/services/checklist';
import { nodeSqlDriver } from './sqlite';

const TOKEN = 'rt_Abc123-xyz_7890QWERTY';

/** The message startRoundtrip() builds. */
async function testMessage() {
  const { raw } = await buildMime({
    from: { address: 'sam@wren.test', name: 'Sam' },
    to: [{ address: 'sam@wren.test', name: 'Sam' }],
    subject: 'Wren delivery test',
    html: `<p>This is an automatic delivery test.</p><p style="color:#888;font-size:12px">Delivery test code: ${TOKEN}</p>`,
    headers: { 'X-Wren-Roundtrip': TOKEN },
  });
  return raw;
}

/** Plausible settings for any provider's form. */
function configFor(type: string): Record<string, unknown> {
  const def = getProviderDef(type)!;
  const cfg: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.default !== undefined) cfg[f.key] = f.default;
    else if (f.type === 'select') cfg[f.key] = f.options?.[0]?.value;
    else if (f.type === 'boolean') cfg[f.key] = false;
    else if (f.type === 'number') cfg[f.key] = 587;
    else if (f.type === 'url' || /url/i.test(f.key)) cfg[f.key] = 'https://provider.example/api';
    else if (/region/i.test(f.key)) cfg[f.key] = 'us-east-1';
    else if (/host/i.test(f.key)) cfg[f.key] = 'smtp.provider.example';
    else cfg[f.key] = 'test-value-123';
  }
  return cfg;
}

/** A response most providers accept as "sent". */
const OK = {
  success: true,
  status: 'success',
  id: 'msg-1',
  message: 'Queued',
  MessageID: 'msg-1',
  MessageId: 'msg-1',
  messageId: 'msg-1',
  result: { message_id: 'msg-1', delivered: ['sam@wren.test'], queued: [], permanent_bounces: [] },
  results: { id: 'msg-1', total_accepted_recipients: 1 },
  Messages: [{ Status: 'success', To: [{ MessageID: 1, MessageUUID: 'u' }] }],
  data: { message_id: 'msg-1', messages: { 'sam@wren.test': { id: 1 } }, succeeded: 1 },
  emails: [{ id: 'msg-1' }],
};

/** What went over the wire, with base64-encoded raw messages (SES, Postal…) decoded. */
const decoded = (text: string) => [text, ...(text.match(/[A-Za-z0-9+/]{200,}={0,2}/g) ?? []).map((m) => Buffer.from(m, 'base64').toString('utf8'))].join('\n');

/** Providers known to drop custom headers unless a paid-plan option is on; the body code covers them. */
const HEADERLESS = new Set(['mailersend']);

beforeAll(() => {
  openDb(nodeSqlDriver(':memory:'));
  invalidateSettings();
});

describe('round-trip test through every provider', () => {
  const outbound = listProviderTypes().filter((t) => t.outbound && getProviderDef(t.type)?.send);

  it('covers the providers people use', () => {
    const types = outbound.map((t) => t.type);
    for (const t of ['resend', 'cloudflare-binding', 'cloudflare', 'ses', 'postmark', 'sendgrid', 'mailgun', 'smtp']) expect(types).toContain(t);
  });

  for (const info of outbound) {
    it(`${info.name} sends the test marker`, async () => {
      const def = getProviderDef(info.type)!;
      const raw = await testMessage();
      const email = await toOutboundEmail(raw, { from: 'sam@wren.test', to: ['sam@wren.test'] });
      expect(email.headers['X-Wren-Roundtrip']).toBe(TOKEN);

      const sent: string[] = [];
      const ctx: ProviderContext = {
        fetch: (async (_url: unknown, init: RequestInit = {}) => {
          sent.push(init.body == null ? '' : await new Response(init.body as BodyInit).text());
          return new Response(JSON.stringify(OK), { status: 200, headers: { 'content-type': 'application/json', 'x-message-id': 'msg-1' } });
        }) as typeof fetch,
      };
      // Providers that don't use HTTP: the Workers send_email binding gets the raw message.
      const original = platform();
      let bindingRaw: string | null = null;
      setPlatform({
        ...original,
        emailBindings: () => ['EMAIL'],
        sendViaBinding: async (_b: string, _from: string, _to: string, mime: Buffer | Uint8Array | string) => {
          bindingRaw = Buffer.from(mime as Buffer).toString('utf8');
          return 'binding-1';
        },
      } as typeof original);
      try {
        await def.send!(configFor(info.type) as any, email, ctx).catch(() => {});
      } finally {
        setPlatform(original);
      }
      const wire = decoded([...sent, bindingRaw ?? ''].join('\n'));
      if (!sent.length && bindingRaw === null) {
        // SMTP and log-only don't use HTTP; they hand over the raw message, which has the header.
        expect(def.rawMime || info.type === 'log' || info.type === 'smtp', `${info.type} sent nothing over HTTP`).toBe(true);
        return;
      }
      expect(wire.includes(TOKEN), `${info.type} dropped the test token`).toBe(true);
      if (!HEADERLESS.has(info.type)) expect(/x-wren-roundtrip/i.test(wire), `${info.type} dropped the X-Wren-Roundtrip header`).toBe(true);
    });
  }

  it('recognises the test coming back with the header, or with only the body code', async () => {
    const withHeader = await parseMail(await testMessage());
    expect(roundtripToken(withHeader, getHeader(withHeader, 'x-wren-roundtrip'))).toBe(TOKEN);

    // As a header-dropping provider delivers it: same subject and body, no custom header.
    const { raw } = await buildMime({
      from: { address: 'sam@wren.test' },
      to: [{ address: 'sam@wren.test' }],
      subject: 'Wren delivery test',
      html: `<p>This is an automatic delivery test.</p><p style="color:#888;font-size:12px">Delivery test code: ${TOKEN}</p>`,
    });
    const stripped = await parseMail(raw);
    expect(getHeader(stripped, 'x-wren-roundtrip')).toBeFalsy();
    expect(roundtripToken(stripped, undefined)).toBe(TOKEN);
    // HTML only (some providers drop the text part).
    expect(roundtripToken({ subject: 'Wren delivery test', text: null, html: `<div>Delivery test code: <b>${TOKEN}</b></div>` }, undefined)).toBe(TOKEN);
    // Ordinary mail is left alone.
    expect(roundtripToken({ subject: 'Lunch?', text: `Delivery test code: ${TOKEN}`, html: null }, undefined)).toBeNull();
  });
});
