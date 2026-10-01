import type { ProviderTypeInfo } from '../../shared/types.js';
import type { ProviderDefinition } from './types.js';
import { smtp } from './outbound/smtp.js';
import { resend } from './outbound/resend.js';
import { cloudflare } from './outbound/cloudflare.js';
import { ses } from './outbound/ses.js';
import { postmark } from './outbound/postmark.js';
import { sendgrid } from './outbound/sendgrid.js';
import { mailgun } from './outbound/mailgun.js';
import { sparkpost } from './outbound/sparkpost.js';
import { brevo } from './outbound/brevo.js';
import { mailjet } from './outbound/mailjet.js';
import { mailersend, mailchannels, smtp2go, zeptomail, elasticemail, mailtrap, scaleway } from './outbound/more.js';
import { postal, webhook, logOnly, rawMime, forwardemail, cloudmailin } from './outbound/selfhosted.js';
import { cloudflareBinding } from './outbound/cloudflare-binding.js';
import { config } from '../config.js';

const definitions: ProviderDefinition<any>[] = [
  cloudflare,
  cloudflareBinding,
  resend,
  ses,
  postmark,
  sendgrid,
  mailgun,
  brevo,
  mailjet,
  sparkpost,
  mailersend,
  mailchannels,
  smtp2go,
  zeptomail,
  elasticemail,
  mailtrap,
  scaleway,
  smtp,
  postal,
  webhook,
  rawMime,
  forwardemail,
  cloudmailin,
  logOnly,
];

const byType = new Map(definitions.map((d) => [d.type, d]));

export function getProviderDef(type: string): ProviderDefinition<any> | undefined {
  return byType.get(type);
}

export function availableOnThisPlatform(d: { platforms?: ('node' | 'workers')[] }): boolean {
  return !d.platforms || d.platforms.includes(config.platform);
}

export function listProviderTypes(): ProviderTypeInfo[] {
  return definitions.filter(availableOnThisPlatform).map((d) => ({
    type: d.type,
    name: d.name,
    description: d.description,
    website: d.website,
    category: d.category,
    outbound: d.outbound,
    inbound: d.inbound,
    rawMime: d.rawMime,
    fields: d.fields,
    spfInclude: d.spfInclude,
    dkimSelectors: d.dkimSelectors,
    inboundSetup:
      d.type === 'cloudflare' && config.platform === 'workers'
        ? 'Wren is running on Cloudflare Workers, so no extra Worker or webhook is needed: in the dashboard enable Email Routing for the domain and set the catch-all (or specific addresses) to “Send to a Worker” → this Wren Worker.'
        : d.inboundSetup,
    outboundSetup:
      d.type === 'smtp' && config.platform === 'workers'
        ? `${d.outboundSetup} On Cloudflare Workers use port 587 (STARTTLS) or 465 (TLS); Cloudflare blocks outbound port 25.`
        : d.outboundSetup,
    presets: d.presets?.filter(availableOnThisPlatform),
    platforms: d.platforms,
  }));
}
