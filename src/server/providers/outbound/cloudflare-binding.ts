import { ProviderError, type ProviderDefinition } from '../types.js';
import { platform } from '../../platform.js';

interface BindingConfig {
  binding: string;
}

/**
 * Send through a Workers `send_email` binding — no API token needed when Wren
 * itself runs on Cloudflare Workers. The raw MIME is handed over as-is.
 */
export const cloudflareBinding: ProviderDefinition<BindingConfig> = {
  type: 'cloudflare-binding',
  name: 'Cloudflare Email (Workers binding)',
  description: 'Send with the send_email binding of this Worker. Zero credentials — available when Wren runs on Cloudflare Workers.',
  website: 'https://developers.cloudflare.com/email-service/',
  category: 'api',
  platforms: ['workers'],
  outbound: true,
  inbound: false,
  rawMime: true,
  dkimSelectors: ['cf2024-1'],
  fields: [{ key: 'binding', label: 'Binding name', type: 'text', default: 'EMAIL', help: 'The [[send_email]] binding name in wrangler.toml.' }],
  outboundSetup:
    'Onboard your domain in Cloudflare Email Service → Email Sending, and keep the [[send_email]] binding (name = "EMAIL") in wrangler.toml. Mail is sent once per recipient, preserving the original headers.',

  async send(cfg, email) {
    const p = platform();
    if (!p.sendViaBinding) throw new ProviderError('The send_email binding is only available on Cloudflare Workers', true);
    const binding = cfg.binding || 'EMAIL';
    const failures: string[] = [];
    for (const rcpt of email.envelope.to) {
      try {
        await p.sendViaBinding(binding, email.envelope.from, rcpt, email.raw);
      } catch (err) {
        failures.push(`${rcpt}: ${(err as Error).message}`);
      }
    }
    if (failures.length === email.envelope.to.length) throw new ProviderError(failures.join('; '), /not (verified|allowed)|invalid/i.test(failures.join(' ')));
    return { providerMessageId: null, detail: failures.length ? `partial failure: ${failures.join('; ')}` : `via binding ${binding}` };
  },
};
