import { ProviderError, type ProviderDefinition } from '../types.js';
import { platform } from '../../platform.js';

interface BindingConfig {
  binding: string;
}

/**
 * Cloudflare Email Service through this Worker's `send_email` binding: no API
 * key, nothing to configure. The raw MIME is handed over unchanged (one
 * envelope per recipient, so Bcc stays private). Incoming mail needs no
 * provider at all: Email Routing delivers it to the Worker's email() handler.
 */
export const cloudflareBinding: ProviderDefinition<BindingConfig> = {
  type: 'cloudflare-binding',
  name: 'Cloudflare Email Service',
  description: 'Built into Cloudflare Workers. Sends with this Worker’s email binding, so there’s no API key. Email Routing delivers incoming mail.',
  website: 'https://developers.cloudflare.com/email-service/',
  category: 'api',
  recommended: true,
  inboundVia: 'Email Routing',
  outbound: true,
  inbound: false,
  rawMime: true,
  dkimSelectors: ['cf2024-1'],
  fields: [{ key: 'binding', label: 'Binding name', type: 'text', default: 'EMAIL', help: 'The [[send_email]] binding in wrangler.toml. Leave as EMAIL.' }],
  outboundSetup:
    'In the Cloudflare dashboard open Email Service → Email Sending and onboard your domain (Cloudflare adds the SPF and DKIM records). Then send a test email. Incoming mail: Email Routing → catch-all → “Send to a Worker” → this Worker.',

  async send(cfg, email) {
    const p = platform();
    if (!p.sendViaBinding) throw new ProviderError('The Cloudflare email binding is not available in this environment', true);
    const binding = cfg.binding || 'EMAIL';
    const failures: string[] = [];
    let messageId: string | null = null;
    for (const rcpt of email.envelope.to) {
      try {
        messageId = (await p.sendViaBinding(binding, email.envelope.from, rcpt, email.raw)) ?? messageId;
      } catch (err) {
        failures.push(`${rcpt}: ${(err as Error).message}`);
      }
    }
    if (failures.length === email.envelope.to.length) {
      const text = failures.join('; ');
      // Unverified sender domain, disallowed address, malformed message: retrying won't help.
      throw new ProviderError(text, /not (verified|allowed|onboarded|authorized)|invalid|forbidden|no such binding/i.test(text));
    }
    return { providerMessageId: messageId, detail: failures.length ? `partial failure: ${failures.join('; ')}` : undefined };
  },

  async verify(cfg) {
    const binding = cfg.binding || 'EMAIL';
    const available = platform().emailBindings?.() ?? [];
    if (!available.includes(binding)) {
      throw new ProviderError(
        available.length
          ? `No email binding named ${binding}. Available: ${available.join(', ')}.`
          : `This Worker has no email binding. Add [[send_email]] name = "${binding}" to wrangler.toml and deploy again.`,
      );
    }
    return `The ${binding} binding is ready. Send a test email to confirm the sending domain is onboarded in Email Service.`;
  },
};
