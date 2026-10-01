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

const definitions: ProviderDefinition<any>[] = [
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
  cloudflare,
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

export function listProviderTypes(): ProviderTypeInfo[] {
  return definitions.map((d) => ({
    type: d.type,
    name: d.name,
    description: d.description,
    website: d.website,
    category: d.category,
    recommended: d.recommended,
    inboundVia: d.inboundVia,
    outbound: d.outbound,
    inbound: d.inbound,
    rawMime: d.rawMime,
    fields: d.fields,
    spfInclude: d.spfInclude,
    dkimSelectors: d.dkimSelectors,
    inboundSetup: d.inboundSetup,
    outboundSetup: d.outboundSetup,
    presets: d.presets,
  }));
}
