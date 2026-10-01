import { ProviderError, type ProviderDefinition } from '../types.js';
import { requireFields } from '../http.js';
import { config } from '../../config.js';
import { smtpSend, smtpVerify, SmtpError, type SmtpSecurity } from '../../mail/smtp-client.js';

interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
  allowSelfSigned?: boolean;
}

const options = (cfg: SmtpConfig) => ({
  host: String(cfg.host).trim(),
  port: Number(cfg.port),
  security: cfg.security ?? 'starttls',
  username: cfg.username || undefined,
  password: cfg.password,
  allowSelfSigned: !!cfg.allowSelfSigned,
  clientName: config.smtp.hostname || new URL(config.publicUrl).hostname,
});

/** Queue id from the final DATA reply: "Ok: queued as 4F1Z2…" (Postfix), "Ok 0100018…" (SES), "id=…". */
function queueId(response: string): string | null {
  return (
    /queued as\s+([\w.-]+)/i.exec(response)?.[1] ??
    /\bid=([\w.@<>-]+)/i.exec(response)?.[1] ??
    /^\d{3} (?:\d\.\d\.\d )?ok:?\s+([\w.-]{6,})/i.exec(response)?.[1] ??
    null
  );
}

export const smtp: ProviderDefinition<SmtpConfig> = {
  type: 'smtp',
  name: 'SMTP relay',
  description: 'Any SMTP server: Gmail / Google Workspace, Microsoft 365, Fastmail, Zoho, iCloud, Postfix, or a provider’s SMTP endpoint.',
  website: 'https://en.wikipedia.org/wiki/Simple_Mail_Transfer_Protocol',
  category: 'smtp',
  outbound: true,
  inbound: false,
  rawMime: true,
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', type: 'number', required: true, default: 587 },
    {
      key: 'security',
      label: 'Security',
      type: 'select',
      default: 'starttls',
      options: [
        { value: 'starttls', label: 'STARTTLS (587)' },
        { value: 'tls', label: 'Implicit TLS (465)' },
        { value: 'none', label: 'None (not recommended)' },
      ],
    },
    { key: 'username', label: 'Username', type: 'text' },
    { key: 'password', label: 'Password / app password', type: 'password' },
    { key: 'allowSelfSigned', label: 'Allow self-signed certificates', type: 'boolean', default: false, help: 'Docker / Node.js only. Cloudflare Workers always verifies certificates.' },
  ],
  presets: [
    { label: 'Gmail / Google Workspace', values: { host: 'smtp.gmail.com', port: 587, security: 'starttls' } },
    { label: 'Google Workspace SMTP relay', values: { host: 'smtp-relay.gmail.com', port: 587, security: 'starttls' } },
    { label: 'Microsoft 365 / Outlook', values: { host: 'smtp.office365.com', port: 587, security: 'starttls' } },
    { label: 'Fastmail', values: { host: 'smtp.fastmail.com', port: 465, security: 'tls' } },
    { label: 'Zoho Mail', values: { host: 'smtp.zoho.com', port: 465, security: 'tls' } },
    { label: 'iCloud Mail', values: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' } },
    { label: 'Proton Mail Bridge', values: { host: '127.0.0.1', port: 1025, security: 'starttls', allowSelfSigned: true }, platforms: ['node'] },
    { label: 'Amazon SES SMTP (us-east-1)', values: { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, security: 'starttls' } },
    { label: 'SendGrid SMTP', values: { host: 'smtp.sendgrid.net', port: 587, security: 'starttls', username: 'apikey' } },
    { label: 'Mailgun SMTP', values: { host: 'smtp.mailgun.org', port: 587, security: 'starttls' } },
    { label: 'Postmark SMTP', values: { host: 'smtp.postmarkapp.com', port: 587, security: 'starttls' } },
    { label: 'Brevo SMTP', values: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' } },
    { label: 'Resend SMTP', values: { host: 'smtp.resend.com', port: 465, security: 'tls', username: 'resend' } },
    { label: 'Local Postfix (port 25)', values: { host: '127.0.0.1', port: 25, security: 'none' }, platforms: ['node'] },
  ],
  outboundSetup:
    'Use an app password where your provider requires one (Gmail, iCloud, Fastmail). The From address must be allowed by the SMTP account.',

  async send(cfg, email) {
    requireFields(cfg, ['host', 'port']);
    try {
      const r = await smtpSend(options(cfg), email.envelope, email.raw);
      const detail = r.rejected.length ? `${r.response} (rejected: ${r.rejected.map((x) => x.address).join(', ')})` : r.response;
      return { providerMessageId: queueId(r.response), detail };
    } catch (err) {
      if (err instanceof SmtpError) throw new ProviderError(err.message, err.permanent, err.code);
      throw new ProviderError((err as Error).message);
    }
  },

  async verify(cfg) {
    requireFields(cfg, ['host', 'port']);
    try {
      const caps = await smtpVerify(options(cfg));
      return `Connected to ${cfg.host}:${cfg.port}${cfg.username ? ' and authenticated' : ''}. Server supports: ${caps.join(', ') || 'basic SMTP'}.`;
    } catch (err) {
      throw new ProviderError((err as Error).message);
    }
  },
};
