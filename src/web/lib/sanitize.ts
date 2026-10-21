import DOMPurify from 'dompurify';
import type { AttachmentInfo } from '../../shared/types';

export interface RenderResult {
  html: string;
  blockedImages: number;
  /** Tracking pixels removed (never loaded, even with images shown). */
  trackers: number;
}

/** Query parameters that only record who clicked; no site needs them to work. utm_* too. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'twclid', 'ttclid', 'li_fat_id', 'yclid', 'igshid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsCtaTracking', 'mkt_tok',
  'oly_anon_id', 'oly_enc_id', 'vero_id', 'vero_conv', '_kx', 'ck_subscriber_id',
]);

/** Redirect pages that carry the real address in a query parameter: host, path, parameters. */
const REDIRECTS: [RegExp, RegExp, string[]][] = [
  [/^(www\.)?google\.(com|[a-z]{2}|com?\.[a-z]{2})$/, /^\/url$/, ['q', 'url']],
  [/\.safelinks\.protection\.outlook\.com$/, /^\//, ['url']],
  [/^(l|lm)\.facebook\.com$|^l\.messenger\.com$/, /^\/l\.php$/, ['u']],
  [/^l\.instagram\.com$/, /^\/$/, ['u']],
  [/^(www\.)?youtube\.com$/, /^\/redirect$/, ['q']],
];

const webUrl = (s: string): URL | null => {
  try {
    // As browsers do: drop tabs and newlines anywhere, and control characters and spaces at the ends.
    const t = s.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
    // "//site/page" is a web link too: it takes the page's own scheme (browsers read \ as / here).
    const u = new URL(/^[/\\]{2}/.test(t) ? `https:${t}` : t);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
};

/**
 * Where a web link really goes: known redirect wrappers unwrapped and tracking
 * parameters dropped. Unchanged links come back exactly as written; null when
 * it isn't an http(s) link.
 */
export function cleanLink(href: string): string | null {
  const parsed = webUrl(href);
  if (!parsed) return null;
  let url = parsed;
  let changed = false;
  for (let hops = 0; hops < 3; hops++) {
    const at = url;
    const wrapper = REDIRECTS.find(([host, path]) => host.test(at.hostname) && path.test(at.pathname));
    const inner = wrapper && webUrl(wrapper[2].map((p) => at.searchParams.get(p)).find(Boolean) ?? '');
    if (!inner) break;
    url = inner;
    changed = true;
  }
  // Filtered by hand so the parameters that stay keep their exact encoding.
  const query = url.search.slice(1).split('&');
  // Marketo's unsubscribe and view-in-browser pages need mkt_tok to know who's asking.
  const marketo = /unsubscribe|emailWebview/i.test(url.pathname + url.search);
  const kept = query.filter((part) => {
    const key = part.split('=', 1)[0];
    return !/^utm_/i.test(key) && (!TRACKING_PARAMS.has(key) || (key === 'mkt_tok' && marketo));
  });
  if (kept.length < query.length) {
    url.search = kept.join('&');
    changed = true;
  }
  return changed ? url.href : href;
}

/** Common file extensions, which make link text like "deck.pptx" look like a domain. */
const FILE_NAME = /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|rtf|csv|txt|md|js|ts|json|xml|html?|css|zip|rar|gz|png|jpe?g|gif|webp|heic|svg|ics|vcf|eml)$/i;

/**
 * The site a link's text names when the text is a web address or domain and the
 * link goes to a different site (the classic phishing trick); otherwise null.
 * Subdomains either way count as the same site.
 */
export function linkMismatch(text: string, href: string): string | null {
  const shown = text.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '').trim().replace(/[.,;:!?)]+$/, '');
  if (!/^(https?:\/\/)?([\p{L}\p{N}-]+\.)+\p{L}{2,}(:\d+)?([/?#]\S*)?$/iu.test(shown)) return null;
  const claimed = webUrl(/^https?:\/\//i.test(shown) ? shown : `http://${shown}`)?.hostname.replace(/^www\./, '');
  // "invoice.pdf", "Node.js", "README.md": a file or product name, unless written as a web address.
  if (claimed && !/^(https?:\/\/|www\.)/i.test(shown) && FILE_NAME.test(claimed)) return null;
  const real = webUrl(href)?.hostname.replace(/^www\./, '');
  if (!claimed || !real || real === claimed || real.endsWith(`.${claimed}`) || claimed.endsWith(`.${real}`)) return null;
  return claimed;
}

/** Well-known email open trackers, matched against host + path. */
const TRACKER_IMAGES = [
  /(^|\.)list-manage\.com\/track\/open/, // Mailchimp
  /(^|\.)mandrillapp\.com\/track\/open/, // Mandrill
  /\/wf\/open$/, // SendGrid, on the sender's own link domain
  /(^|\.)awstrack\.me\//, // Amazon SES
  /\/__ptq\.gif$/, // HubSpot
  /(^|\.)exct\.net\/open\.aspx/, // Salesforce Marketing Cloud
  /(^|\.)rs6\.net\/on\.jsp/, // Constant Contact
  /(^|\.)mailtrack\.io\/trace/, // Mailtrack
  /(^|\.)t\.yesware\.com\//, // Yesware
  /(^|\.)mailfoogae\.appspot\.com\//, // Streak
];

/**
 * A remote picture whose only job is to tell the sender the email was opened:
 * 0–2px (CSS beats the width/height attributes, as in the browser), hidden, or
 * from a known tracker. A hidden picture with a real size stays: responsive
 * mail hides its phone-only pictures and shows them with @media rules.
 */
export function isTrackingPixel(attr: (name: string) => string | null): boolean {
  const src = attr('src')?.trim() ?? '';
  if (!/^(https?:)?\/\//i.test(src)) return false; // embedded pictures can't report back
  const style = (attr('style') ?? '').toLowerCase();
  const size = (name: string): number | undefined => {
    const css = new RegExp(`(?:^|;)\\s*${name}\\s*:([^;]*)`).exec(style)?.[1].replace('!important', '');
    const v = (css ?? attr(name))?.trim().toLowerCase();
    return v ? (/^[\d.]+(px)?$/.test(v) ? parseFloat(v) : NaN) : undefined; // NaN: 100%, auto…
  };
  const dims = [size('width'), size('height')].filter((d) => d !== undefined);
  const tiny = dims.length > 0 && dims.every((d) => d <= 2);
  const hidden = attr('hidden') !== null || /(?:^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/.test(style);
  if (tiny || (hidden && !dims.some((d) => !(d <= 2)))) return true;
  try {
    const u = new URL(src, 'https://wren.invalid');
    return TRACKER_IMAGES.some((re) => re.test(u.hostname + u.pathname));
  } catch {
    return false;
  }
}

/** HTML shown in the main document while composing must be safe even without a CSP. */
export function sanitizeEditorHtml(html: string): string {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    const classes = el.getAttribute('class');
    if (classes) {
      const allowed = classes.split(/\s+/).filter((name) => ['wren-quote', 'wren-forward', 'wren-signature'].includes(name));
      if (allowed.length) el.setAttribute('class', allowed.join(' '));
      else el.removeAttribute('class');
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src');
      if (src && !/^\/api\/attachments\/\d+\?inline=1$/.test(src)) el.removeAttribute('src');
    }
  });
  try {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'svg', 'math', 'audio', 'video'],
      FORBID_ATTR: ['style', 'id', 'srcset', 'background', 'formaction'],
    }) as string;
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/**
 * A whole email document (<html><head>…<body>) keeps what sanitizing just the
 * body would lose: its <style> blocks, which carry the phone layout (@media
 * rules), and the body's own background and text colour. The body becomes a div.
 */
function keepDocumentStyles(html: string): string {
  if (!/<(head|body)[\s>]/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: nothing runs or loads
  const styles = [...doc.querySelectorAll('style')].filter((s) => !doc.body.contains(s));
  const body = doc.body;
  const css = [body.getAttribute('bgcolor') && `background-color:${body.getAttribute('bgcolor')}`, body.getAttribute('text') && `color:${body.getAttribute('text')}`, body.getAttribute('style')]
    .filter(Boolean)
    .join(';');
  const wrap = doc.createElement('div');
  if (css) wrap.setAttribute('style', css);
  wrap.innerHTML = body.innerHTML;
  return styles.map((st) => st.outerHTML).join('') + wrap.outerHTML;
}

/**
 * Tags dropped from received mail. Pictures and media that load outside <img>
 * (SVG <image>/<feImage>, <picture><source srcset>, <video poster>, <audio>)
 * would get past image blocking, so they go, as in Gmail.
 */
export const MAIL_FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'image', 'feImage', 'source', 'video', 'audio'];

/**
 * Sanitize message HTML for display:
 *  - keeps a full document's <style> blocks and body colours
 *  - strips scripts, forms, event handlers (DOMPurify)
 *  - rewrites cid: references to attachment URLs
 *  - removes tracking pixels outright, even when images are allowed
 *  - blocks remote images/backgrounds unless allowed (tracking protection)
 *  - loads allowed ones through Wren's image proxy when the server signed them
 *    (`proxy`: {url: sig}), so the sender never sees the reader's address
 *  - opens links in a new tab without a referrer, unwraps redirects and strips
 *    tracking parameters, titles them with where they go, and marks those whose
 *    text names another site (data-wren-shows) so the reader is asked first
 */
export function renderMailHtml(
  html: string,
  opts: { attachments: AttachmentInfo[]; allowRemote: boolean; proxy?: Record<string, string>; attachmentUrl?: (id: number) => string },
): RenderResult {
  const cidMap = new Map<string, number>();
  for (const a of opts.attachments) if (a.contentId) cidMap.set(a.contentId.toLowerCase(), a.id);
  let blocked = 0;
  let trackers = 0;

  const isRemote = (url: string) => /^(https?:)?\/\//i.test(url.trim());
  /** The same address the server signed (see normalizeImageUrl in image-proxy.ts). */
  const proxied = (url: string): string => {
    const t = url.trim();
    const abs = t.startsWith('//') ? `https:${t}` : t;
    const sig = opts.proxy?.[abs];
    return sig ? `/api/img/${sig}?u=${encodeURIComponent(abs)}` : t;
  };
  const fixUrl = (url: string): string | null => {
    const u = url.trim();
    if (/^cid:/i.test(u)) {
      const id = cidMap.get(u.slice(4).replace(/[<>]/g, '').toLowerCase());
      return id ? (opts.attachmentUrl?.(id) ?? `/api/attachments/${id}?inline=1`) : '';
    }
    if (isRemote(u) && !opts.allowRemote) {
      blocked++;
      return null;
    }
    return isRemote(u) ? proxied(u) : u;
  };

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    el.removeAttribute('data-wren-shows'); // only ever set below
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
      const real = cleanLink(el.getAttribute('href') ?? '');
      if (real) {
        el.setAttribute('href', real);
        el.setAttribute('title', real);
        const claimed = linkMismatch(el.textContent ?? '', real);
        if (claimed) el.setAttribute('data-wren-shows', claimed);
      }
    }
    if (el.tagName === 'IMG') {
      if (isTrackingPixel((name) => el.getAttribute(name))) {
        trackers++;
        el.remove();
        return;
      }
      const src = el.getAttribute('src');
      if (src) {
        const fixed = fixUrl(src);
        if (fixed === null) {
          el.setAttribute('data-blocked-src', src);
          el.removeAttribute('src');
          el.setAttribute('alt', el.getAttribute('alt') || '');
        } else el.setAttribute('src', fixed);
      }
      el.removeAttribute('srcset');
    }
    if (el.hasAttribute('background')) {
      const bg = fixUrl(el.getAttribute('background') ?? '');
      if (bg === null) el.removeAttribute('background');
      else el.setAttribute('background', bg);
    }
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) {
      el.setAttribute(
        'style',
        style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, _q, url: string) => {
          const fixed = fixUrl(url);
          return fixed === null ? 'none' : `url("${fixed}")`;
        }),
      );
    }
  });

  try {
    let clean = DOMPurify.sanitize(keepDocumentStyles(html), {
      WHOLE_DOCUMENT: false,
      // Otherwise leading <style> blocks are parsed into <head> and dropped.
      FORCE_BODY: true,
      FORBID_TAGS: MAIL_FORBID_TAGS,
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ADD_ATTR: ['target'],
    }) as string;
    // Remote CSS in <style> blocks (e.g. @import, url()) is also a tracking vector.
    if (!opts.allowRemote) {
      clean = clean.replace(/@import[^;]+;/gi, '').replace(/url\(\s*(['"]?)(https?:)?\/\/[^)]*\)/gi, () => {
        blocked++;
        return 'none';
      });
    } else if (opts.proxy) {
      clean = clean.replace(/url\(\s*(['"]?)((?:https?:)?\/\/[^'")]+)\1\s*\)/gi, (m, _q, url: string) => {
        const p = proxied(url);
        return p === url.trim() ? m : `url("${p}")`;
      });
    }
    return { html: clean, blockedImages: blocked, trackers };
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/** Plain-text bodies: escape, linkify, and style quoted lines. Links are cleaned like HTML ones; their text is the address as written. */
export function textToSafeHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // The split keeps each address at an odd index.
  const linked = text
    .split(/(\bhttps?:\/\/[^\s<>"')]+)/)
    .map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const real = esc(cleanLink(part) ?? part);
      return `<a href="${real}" title="${real}" target="_blank" rel="noopener noreferrer nofollow">${esc(part)}</a>`;
    })
    .join('');
  return `<div style="white-space:pre-wrap;word-break:break-word;font-family:inherit">${linked}</div>`;
}
