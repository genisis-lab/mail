import { Hono } from 'hono';
import { get } from '../db/index.js';
import { logger } from '../lib/log.js';
import { decryptJson } from '../lib/crypto.js';
import { ingest } from '../mail/ingest.js';
import { providerContext } from '../mail/outbound.js';
import { getProviderDef } from '../providers/registry.js';
import { ProviderError, type InboundRequest } from '../providers/types.js';
import { recordDeliveryEvents } from '../services/delivery-events.js';
import { insert, now } from '../db/index.js';

const log = logger('inbound');

export const inboundRoutes = new Hono();

const MAX_BODY = 60 * 1024 * 1024;

async function handle(c: any) {
  const token = c.req.param('token');
  const provider = get<{ id: number; name: string; type: string; config: string; enabled: number }>(
    'SELECT id, name, type, config, enabled FROM providers WHERE inbound_token = ?',
    [token],
  );
  if (!provider || !provider.enabled) return c.json({ error: 'Unknown endpoint' }, 404);
  const def = getProviderDef(provider.type);
  if (!def?.receive) return c.json({ error: 'This provider does not accept inbound mail' }, 400);

  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_BODY) return c.json({ error: 'Payload too large' }, 413);
  const bodyBuf = Buffer.from(await c.req.arrayBuffer());
  if (bodyBuf.length > MAX_BODY) return c.json({ error: 'Payload too large' }, 413);
  const contentType = c.req.header('content-type') ?? '';
  let formCache: FormData | null = null;
  let jsonCache: unknown;
  const req: InboundRequest = {
    method: c.req.method,
    headers: c.req.raw.headers,
    url: new URL(c.req.url),
    body: bodyBuf,
    contentType,
    async form() {
      if (!formCache) formCache = await new Response(new Uint8Array(bodyBuf), { headers: { 'content-type': contentType } }).formData();
      return formCache;
    },
    json<T>() {
      if (jsonCache === undefined) {
        try {
          jsonCache = JSON.parse(bodyBuf.toString('utf8'));
        } catch {
          throw new ProviderError('Invalid JSON payload', true, 400);
        }
      }
      return jsonCache as T;
    },
  };

  let cfg: Record<string, any> = {};
  try {
    cfg = decryptJson(provider.config);
  } catch {
    log.error(`Cannot decrypt provider ${provider.name}`);
  }

  try {
    const result = await def.receive(cfg, req, providerContext);
    if (result.events?.length) await recordDeliveryEvents(provider.id, result.events);
    const outcome = { accepted: [] as string[], rejected: [] as { rcpt: string; reason: string }[], delivered: 0 };
    for (const item of result.items ?? []) {
      const r = await ingest(item.raw, {
        rcptTo: item.rcptTo,
        mailFrom: item.mailFrom,
        source: `webhook:${provider.type}`,
        providerId: provider.id,
        verdicts: item.verdicts,
        providerScore: item.spamScore,
      });
      outcome.accepted.push(...r.accepted);
      outcome.rejected.push(...r.rejected);
      outcome.delivered += r.delivered;
    }
    if (result.response) return c.json(result.response.body, result.response.status);
    return c.json(outcome, 200);
  } catch (err) {
    if (err instanceof ProviderError && err.status && err.status < 500) {
      insert(
        `INSERT INTO inbound_log (source, provider_id, status, reason, size, created_at) VALUES (?, ?, 'error', ?, ?, ?)`,
        [`webhook:${provider.type}`, provider.id, err.message, bodyBuf.length, now()],
      );
      return c.json({ error: err.message }, err.status);
    }
    log.error(`Inbound webhook for ${provider.name} failed`, err);
    // 5xx makes providers retry later.
    return c.json({ error: 'Processing failed' }, 500);
  }
}

inboundRoutes.post('/:token', handle);
inboundRoutes.post('/:token/*', handle);
// Some providers validate the URL with a GET/HEAD first.
inboundRoutes.get('/:token', (c) => c.json({ ok: true }));
