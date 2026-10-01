import { ProviderError, type ProviderDefinition } from '../types.js';
import { requireFields } from '../http.js';

interface SmtpConfig {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  username?: string;
  password?: string;
  allowSelfSigned?: boolean;
}

async function transport(cfg: SmtpConfig) {
  // Loaded lazily: nodemailer needs raw TCP sockets, which only exist on Node.js.
  const nodemailer = (await import('nodemailer')).default;
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: cfg.security === 'tls',
    requireTLS: cfg.security === 'starttls',
    ignoreTLS: cfg.security === 'none',
    auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? '' } : undefined,
    tls: { rejectUnauthorized: !cfg.allowSelfSigned },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
}

export const smtp: ProviderDefinition<SmtpConfig> = {
  type: 'smtp',
  name: 'SMTP relay',
  description: 'Any SMTP server: Gmail / Google Workspace, Microsoft 365, Fastmail, Zoho, iCloud, Postfix, or a provider’s SMTP endpoint.',
  website: 'https://en.wikipedia.org/wiki/Simple_Mail_Transfer_Protocol',
  category: 'smtp',
  platforms: ['node'],
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
    { key: 'allowSelfSigned', label: 'Allow self-signed certificates', type: 'boolean', default: false },
  ],
  presets: [
    { label: 'Gmail / Google Workspace', values: { host: 'smtp.gmail.com', port: 587, security: 'starttls' } },
    { label: 'Google Workspace SMTP relay', values: { host: 'smtp-relay.gmail.com', port: 587, security: 'starttls' } },
    { label: 'Microsoft 365 / Outlook', values: { host: 'smtp.office365.com', port: 587, security: 'starttls' } },
    { label: 'Fastmail', values: { host: 'smtp.fastmail.com', port: 465, security: 'tls' } },
    { label: 'Zoho Mail', values: { host: 'smtp.zoho.com', port: 465, security: 'tls' } },
    { label: 'iCloud Mail', values: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' } },
    { label: 'Proton Mail Bridge', values: { host: '127.0.0.1', port: 1025, security: 'starttls', allowSelfSigned: true } },
    { label: 'Amazon SES SMTP (us-east-1)', values: { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, security: 'starttls' } },
    { label: 'SendGrid SMTP', values: { host: 'smtp.sendgrid.net', port: 587, security: 'starttls', username: 'apikey' } },
    { label: 'Mailgun SMTP', values: { host: 'smtp.mailgun.org', port: 587, security: 'starttls' } },
    { label: 'Postmark SMTP', values: { host: 'smtp.postmarkapp.com', port: 587, security: 'starttls' } },
    { label: 'Brevo SMTP', values: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' } },
    { label: 'Resend SMTP', values: { host: 'smtp.resend.com', port: 465, security: 'tls', username: 'resend' } },
    { label: 'Local Postfix (port 25)', values: { host: '127.0.0.1', port: 25, security: 'none' } },
  ],
  outboundSetup:
    'Use an app password where your provider requires one (Gmail, iCloud, Fastmail). The From address must be allowed by the SMTP account.',

  async send(cfg, email) {
    requireFields(cfg, ['host', 'port']);
    try {
      const info = await (await transport(cfg)).sendMail({ envelope: email.envelope, raw: email.raw });
      if (info.rejected?.length && !info.accepted?.length) {
        throw new ProviderError(`All recipients rejected: ${info.rejected.join(', ')}`, true);
      }
      return { providerMessageId: info.messageId ?? null, detail: info.response };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      const code = Number(err.responseCode);
      throw new ProviderError(err.message, code >= 500 && code < 600, code || undefined);
    }
  },

  async verify(cfg) {
    requireFields(cfg, ['host', 'port']);
    try {
      await (await transport(cfg)).verify();
      return `Connected to ${cfg.host}:${cfg.port} and authenticated.`;
    } catch (err) {
      throw new ProviderError((err as Error).message);
    }
  },
};
