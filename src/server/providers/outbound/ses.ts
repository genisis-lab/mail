import { ProviderError, type ProviderDefinition } from '../types.js';
import { request, requireFields } from '../http.js';
import { signAws } from '../../lib/aws.js';

interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  configurationSet?: string;
  topicArn?: string;
}

export const ses: ProviderDefinition<SesConfig> = {
  type: 'ses',
  name: 'Amazon SES',
  description: 'Amazon Simple Email Service (v2 API, raw MIME). Inbound via SES receipt rules → SNS (or S3 + SNS).',
  website: 'https://aws.amazon.com/ses/',
  category: 'api',
  outbound: true,
  inbound: true,
  rawMime: true,
  spfInclude: 'amazonses.com',
  fields: [
    { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1', placeholder: 'us-east-1' },
    { key: 'accessKeyId', label: 'Access key ID', type: 'text', required: true },
    { key: 'secretAccessKey', label: 'Secret access key', type: 'password', required: true },
    { key: 'configurationSet', label: 'Configuration set', type: 'text', help: 'Optional SES configuration set name.' },
    {
      key: 'topicArn',
      label: 'Allowed SNS topic ARN',
      type: 'text',
      inbound: true,
      help: 'Only accept inbound notifications from this topic (recommended).',
    },
  ],
  outboundSetup: 'Verify your domain identity in SES (Easy DKIM), request production access, and create an IAM user allowed to call ses:SendEmail / ses:SendRawEmail.',
  inboundSetup:
    'In SES, add a receipt rule for your domain with an SNS action (encoding: Base64) — or an S3 action plus SNS topic for large mail. Subscribe {{url}} to the topic (HTTPS); Wren confirms the subscription automatically. For S3, the IAM user also needs s3:GetObject on the bucket.',

  async send(cfg, email, ctx) {
    requireFields(cfg, ['region', 'accessKeyId', 'secretAccessKey']);
    const url = `https://email.${cfg.region}.amazonaws.com/v2/email/outbound-emails`;
    const body = JSON.stringify({
      FromEmailAddress: email.envelope.from,
      Destination: { ToAddresses: email.envelope.to },
      Content: { Raw: { Data: email.raw.toString('base64') } },
      ConfigurationSetName: cfg.configurationSet || undefined,
    });
    const headers = signAws({
      method: 'POST',
      url,
      region: cfg.region,
      service: 'ses',
      body,
      headers: { 'content-type': 'application/json' },
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    const { data } = await request<{ MessageId: string }>(ctx, url, { method: 'POST', headers, body, timeoutMs: 60_000 });
    return { providerMessageId: data?.MessageId ?? null };
  },

  async verify(cfg, ctx) {
    requireFields(cfg, ['region', 'accessKeyId', 'secretAccessKey']);
    const url = `https://email.${cfg.region}.amazonaws.com/v2/email/account`;
    const headers = signAws({
      method: 'GET',
      url,
      region: cfg.region,
      service: 'ses',
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    const { data } = await request<any>(ctx, url, { headers });
    const quota = data?.SendQuota;
    return `Credentials valid. Production access: ${data?.ProductionAccessEnabled ? 'yes' : 'no (sandbox)'}${
      quota ? `, 24h quota ${quota.SentLast24Hours}/${quota.Max24HourSend}` : ''
    }.`;
  },

  async receive(cfg, req, ctx) {
    const msg = req.json<any>();
    if (cfg.topicArn && msg?.TopicArn && msg.TopicArn !== cfg.topicArn) {
      throw new ProviderError('Unexpected SNS topic', true, 403);
    }
    if (msg?.Type === 'SubscriptionConfirmation') {
      const subscribeUrl = new URL(msg.SubscribeURL);
      if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(subscribeUrl.hostname)) {
        throw new ProviderError('Refusing to confirm a non-AWS subscription URL', true, 400);
      }
      await ctx.fetch(subscribeUrl.toString(), { signal: AbortSignal.timeout(15_000) });
      return { response: { status: 200, body: { confirmed: true } } };
    }
    if (msg?.Type !== 'Notification') return { response: { status: 200, body: { ignored: msg?.Type ?? 'unknown' } } };

    const n = typeof msg.Message === 'string' ? JSON.parse(msg.Message) : msg.Message;
    if (n?.notificationType !== 'Received') return { response: { status: 200, body: { ignored: n?.notificationType } } };

    let raw: Buffer;
    if (n.content) {
      raw = n.receipt?.action?.encoding === 'BASE64' ? Buffer.from(n.content, 'base64') : Buffer.from(n.content, 'utf8');
    } else if (n.receipt?.action?.type === 'S3') {
      requireFields(cfg, ['accessKeyId', 'secretAccessKey']);
      const { bucketName, objectKey } = n.receipt.action;
      const region = cfg.region || 'us-east-1';
      const url = `https://${bucketName}.s3.${region}.amazonaws.com/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
      const headers = signAws({
        method: 'GET',
        url,
        region,
        service: 's3',
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
      const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new ProviderError(`S3 fetch failed: HTTP ${res.status}`);
      raw = Buffer.from(await res.arrayBuffer());
    } else {
      throw new ProviderError('Notification has no content. Use SNS encoding Base64 or an S3 action.', true, 400);
    }

    const r = n.receipt ?? {};
    if (r.virusVerdict?.status === 'FAIL') {
      return { response: { status: 200, body: { dropped: 'virus' } } };
    }
    const verdicts: Record<string, string> = {};
    for (const k of ['spf', 'dkim', 'dmarc', 'spam']) {
      const v = r[`${k}Verdict`]?.status;
      if (v) verdicts[k] = String(v).toLowerCase();
    }
    return {
      items: [
        {
          raw,
          rcptTo: r.recipients ?? n.mail?.destination,
          mailFrom: n.mail?.source,
          verdicts,
          spamScore: verdicts.spam === 'fail' ? 10 : undefined,
        },
      ],
    };
  },
};
