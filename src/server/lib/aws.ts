import crypto from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Sign a request with AWS Signature Version 4. Returns the headers to send
 * (including Authorization). Works for SES v2, S3 and SNS.
 */
export function signAws(opts: {
  method: string;
  url: string;
  region: string;
  service: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  credentials: AwsCredentials;
  date?: Date;
}): Record<string, string> {
  const url = new URL(opts.url);
  const body = opts.body ?? '';
  const date = opts.date ?? new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
    host: url.host,
    'x-amz-date': amzDate,
  };
  if (opts.service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  if (opts.credentials.sessionToken) headers['x-amz-security-token'] = opts.credentials.sessionToken;

  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = Object.keys(lower).sort().join(';');
  const canonicalHeaders = Object.keys(lower)
    .sort()
    .map((k) => `${k}:${lower[k]}\n`)
    .join('');

  const segments = url.pathname.split('/').map((seg) => encodeRfc3986(decodeURIComponent(seg)));
  const canonicalUri =
    opts.service === 's3' ? segments.join('/') || '/' : segments.map((s) => encodeRfc3986(s)).join('/') || '/';
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [opts.method.toUpperCase(), canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${opts.credentials.secretAccessKey}`, day);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const out = { ...headers };
  delete (out as any).host;
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
