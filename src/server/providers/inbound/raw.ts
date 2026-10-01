import { ProviderError, type InboundRequest, type InboundResult } from '../types.js';

function splitList(v: string | null | undefined): string[] {
  return (v ?? '')
    .split(/[,\s]+/)
    .map((s) => s.replace(/[<>]/g, '').trim())
    .filter((s) => s.includes('@'));
}

/**
 * Accept a raw RFC 5322 message posted over HTTP. Works for the Cloudflare
 * Email Worker, MTA pipes (curl --data-binary @-), and any service that can
 * POST the original message. Envelope comes from X-Mail-From / X-Rcpt-To
 * headers or ?from= / ?to= query parameters.
 */
export async function rawInbound(req: InboundRequest): Promise<InboundResult> {
  const ct = req.contentType.toLowerCase();
  let raw: Buffer | null = null;
  let rcptTo = splitList(req.headers.get('x-rcpt-to') ?? req.headers.get('x-envelope-to') ?? req.url.searchParams.get('to'));
  let mailFrom = (req.headers.get('x-mail-from') ?? req.headers.get('x-envelope-from') ?? req.url.searchParams.get('from') ?? '').trim();

  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const form = await req.form();
    for (const key of ['message', 'email', 'mime', 'body-mime', 'raw']) {
      const v = form.get(key);
      if (v == null) continue;
      raw = typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(await v.arrayBuffer());
      break;
    }
    if (!rcptTo.length) rcptTo = splitList((form.get('to') ?? form.get('recipient') ?? form.get('envelope[to]')) as string | null);
    if (!mailFrom) mailFrom = String(form.get('from') ?? form.get('sender') ?? form.get('envelope[from]') ?? '');
  } else if (ct.includes('application/json')) {
    const body = req.json<any>();
    const r = body?.raw ?? body?.message ?? body?.mime;
    if (typeof r === 'string') raw = Buffer.from(r, body.base64 || body.encoding === 'base64' ? 'base64' : 'utf8');
    if (!rcptTo.length) rcptTo = splitList(Array.isArray(body?.rcptTo) ? body.rcptTo.join(',') : body?.rcptTo ?? body?.to);
    if (!mailFrom) mailFrom = String(body?.mailFrom ?? body?.from ?? '');
  } else {
    raw = req.body;
  }
  if (!raw || raw.length === 0) throw new ProviderError('No message body found', true, 400);
  return { items: [{ raw, rcptTo: rcptTo.length ? rcptTo : undefined, mailFrom: mailFrom || undefined }] };
}
