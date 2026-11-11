/**
 * New messages that start outside Wren: a mailto: link (RFC 6068), and files,
 * links or text shared from another app (the manifest's share_target; the
 * service worker keeps the share in a cache until the page picks it up).
 */
import type { Addr, AttachmentInfo } from '../../shared/types';
import type { ComposeInit } from '../components/Compose';
import { api } from './api';

/** Where the service worker keeps a share; sw.js uses the same name. */
export const SHARE_CACHE = 'wren-share';

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const addresses = (s: string): Addr[] =>
  decode(s)
    .split(',')
    .map((a) => a.trim())
    .filter((a) => /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(a))
    .map((address) => ({ address }));

/** A mailto: link as a new message. "+" stays a plus sign, as RFC 6068 says. */
export function mailtoMessage(link: string): ComposeInit | null {
  const m = /^mailto:([^?#]*)(?:\?([^#]*))?/i.exec(link.trim());
  if (!m) return null;
  const out = { to: addresses(m[1]), cc: [] as Addr[], bcc: [] as Addr[], subject: '', text: '' };
  for (const pair of (m[2] ?? '').split('&')) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const key = decode(pair.slice(0, i)).toLowerCase();
    const value = pair.slice(i + 1);
    if (key === 'to' || key === 'cc' || key === 'bcc') out[key].push(...addresses(value));
    else if (key === 'subject') out.subject = decode(value).slice(0, 998);
    else if (key === 'body') out.text = decode(value);
  }
  return out;
}

/** A share the service worker kept, as a new message with its files attached. Read once: it's deleted here. */
export async function sharedMessage(id: string): Promise<ComposeInit | null> {
  const cache = await caches.open(SHARE_CACHE);
  const key = `/share/${id}`;
  const res = await cache.match(key);
  await cache.delete(key);
  if (!res) return null;
  const form = await res.formData();
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v.trim() : '';
  };
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  let attachments: AttachmentInfo[] = [];
  if (files.length) {
    const upload = new FormData();
    for (const f of files) upload.append('file', f);
    attachments = (await api.post<{ attachments: AttachmentInfo[] }>('/api/compose/uploads', upload)).attachments;
  }
  // Some apps put the link in the text too.
  const url = field('url');
  const text = field('text');
  return { subject: field('title'), text: url && !text.includes(url) ? [text, url].filter(Boolean).join('\n') : text, attachments };
}
