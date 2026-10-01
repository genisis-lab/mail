import { ProviderError, type ProviderDefinition } from '../types.js';
import { request, requireFields } from '../http.js';

interface CloudflareConfig {
  accountId: string;
  apiToken: string;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

interface CfSendResult {
  message_id: string;
  delivered: string[];
  queued: string[];
  permanent_bounces: string[];
  suppressed_recipients?: string[];
}

export const cloudflare: ProviderDefinition<CloudflareConfig> = {
  type: 'cloudflare',
  name: 'Cloudflare Email Service (API token)',
  description: 'Send through the Email Sending REST API, for example from another Cloudflare account. Most setups should use the built-in Cloudflare Email Service instead.',
  website: 'https://developers.cloudflare.com/email-service/',
  category: 'api',
  outbound: true,
  inbound: false,
  rawMime: true,
  dkimSelectors: ['cf2024-1'],
  fields: [
    { key: 'accountId', label: 'Account ID', type: 'text', required: true, help: 'Found in the Cloudflare dashboard sidebar.' },
    {
      key: 'apiToken',
      label: 'API token',
      type: 'password',
      required: true,
      help: 'A token with the Email Sending “Send” permission for this account.',
    },
  ],
  outboundSetup: 'Onboard your domain under Email Service → Email Sending in the Cloudflare dashboard, then create an API token that can send email.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['accountId', 'apiToken']);
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/email/sending/send_raw`;
    const { data } = await request<CfEnvelope<CfSendResult>>(ctx, url, {
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
      json: { from: email.envelope.from, recipients: email.envelope.to, mime_message: email.raw.toString('utf8') },
      timeoutMs: 60_000,
    });
    if (!data?.success) {
      throw new ProviderError(data?.errors?.map((e) => e.message).join('; ') || 'Cloudflare rejected the message', true);
    }
    const r = data.result;
    const ok = (r.delivered?.length ?? 0) + (r.queued?.length ?? 0);
    if (!ok && r.permanent_bounces?.length) {
      throw new ProviderError(`Permanent bounce: ${r.permanent_bounces.join(', ')}`, true);
    }
    const notes = [
      r.queued?.length ? `queued: ${r.queued.join(', ')}` : '',
      r.permanent_bounces?.length ? `bounced: ${r.permanent_bounces.join(', ')}` : '',
      r.suppressed_recipients?.length ? `suppressed: ${r.suppressed_recipients.join(', ')}` : '',
    ].filter(Boolean);
    return { providerMessageId: r.message_id, detail: notes.join('; ') || undefined };
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['accountId', 'apiToken']);
    const headers = { Authorization: `Bearer ${cfg.apiToken}` };
    // Account-owned tokens verify under the account; user tokens under /user.
    const urls = [
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/tokens/verify`,
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
    ];
    let lastErr: unknown;
    for (const url of urls) {
      try {
        const { data } = await request<CfEnvelope<{ status: string }>>(ctx, url, { headers });
        return `API token is ${data?.result?.status ?? 'valid'}.`;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  },

};
