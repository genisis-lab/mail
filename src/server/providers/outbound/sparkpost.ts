import { ProviderError, type ProviderDefinition, type InboundItem } from '../types.js';
import { request, requireFields } from '../http.js';

interface SparkpostConfig {
  apiKey: string;
  region?: 'us' | 'eu';
  relayToken?: string;
}

export const sparkpost: ProviderDefinition<SparkpostConfig> = {
  type: 'sparkpost',
  name: 'SparkPost (Bird)',
  description: 'SparkPost Transmissions API with raw RFC 822 content, and Relay Webhooks for inbound.',
  website: 'https://www.sparkpost.com',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: true,
  spfInclude: 'sparkpostmail.com',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true },
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      default: 'us',
      options: [
        { value: 'us', label: 'US (api.sparkpost.com)' },
        { value: 'eu', label: 'EU (api.eu.sparkpost.com)' },
      ],
    },
    { key: 'relayToken', label: 'Relay webhook auth token', type: 'password', inbound: true, help: 'The auth_token set on the relay webhook.' },
  ],
  outboundSetup: 'Add and verify a sending domain in SparkPost, then create an API key with Transmissions: Read/Write.',
  inboundSetup:
    'Create an inbound domain in SparkPost (MX → rx1/rx2/rx3.sparkpostmail.com), then a Relay Webhook targeting {{url}} with an auth token matching the one here.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['apiKey']);
    const base = cfg.region === 'eu' ? 'https://api.eu.sparkpost.com' : 'https://api.sparkpost.com';
    const { data } = await request<{ results: { id: string; total_rejected_recipients: number; total_accepted_recipients: number } }>(
      ctx,
      `${base}/api/v1/transmissions`,
      {
        headers: { Authorization: cfg.apiKey },
        json: {
          options: { transactional: true },
          recipients: email.envelope.to.map((r) => ({ address: { email: r } })),
          content: { email_rfc822: email.raw.toString('utf8') },
        },
        timeoutMs: 60_000,
      },
    );
    if (data?.results && data.results.total_accepted_recipients === 0) {
      throw new ProviderError('SparkPost rejected all recipients', true);
    }
    return { providerMessageId: data?.results?.id ?? null };
  },

  async sendingDomains(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const base = cfg.region === 'eu' ? 'https://api.eu.sparkpost.com' : 'https://api.sparkpost.com';
    const { data } = await request<{ results: { domain: string; status?: { ownership_verified?: boolean; dkim_status?: string } }[] }>(ctx, `${base}/api/v1/sending-domains`, {
      headers: { Authorization: cfg.apiKey },
    });
    return (data?.results ?? []).map((d) => ({ name: d.domain.toLowerCase(), verified: !!d.status?.ownership_verified || d.status?.dkim_status === 'valid' }));
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['apiKey']);
    const base = cfg.region === 'eu' ? 'https://api.eu.sparkpost.com' : 'https://api.sparkpost.com';
    const { data } = await request<{ results: { domain: string }[] }>(ctx, `${base}/api/v1/sending-domains`, {
      headers: { Authorization: cfg.apiKey },
    });
    return `API key valid. Sending domains: ${(data?.results ?? []).map((d) => d.domain).join(', ') || 'none'}.`;
  },

  async receive(cfg, req) {
    if (cfg.relayToken && req.headers.get('x-messagesystems-webhook-token') !== cfg.relayToken) {
      throw new ProviderError('Invalid relay webhook token', true, 401);
    }
    const events = req.json<any[]>();
    const items: InboundItem[] = [];
    for (const e of Array.isArray(events) ? events : []) {
      const m = e?.msys?.relay_message;
      if (!m?.content?.email_rfc822) continue;
      items.push({
        raw: Buffer.from(m.content.email_rfc822, m.content.email_rfc822_is_base64 ? 'base64' : 'utf8'),
        rcptTo: m.rcpt_to ? [m.rcpt_to] : undefined,
        mailFrom: m.msg_from,
      });
    }
    return { items };
  },
};
