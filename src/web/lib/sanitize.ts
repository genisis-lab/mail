import DOMPurify from 'dompurify';
import type { AttachmentInfo } from '../../shared/types';

export interface RenderResult {
  html: string;
  blockedImages: number;
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
 * Sanitize message HTML for display:
 *  - strips scripts, forms, event handlers (DOMPurify)
 *  - rewrites cid: references to attachment URLs
 *  - blocks remote images/backgrounds unless allowed (tracking protection)
 *  - opens links in a new tab without a referrer
 */
export function renderMailHtml(html: string, opts: { attachments: AttachmentInfo[]; allowRemote: boolean }): RenderResult {
  const cidMap = new Map<string, number>();
  for (const a of opts.attachments) if (a.contentId) cidMap.set(a.contentId.toLowerCase(), a.id);
  let blocked = 0;

  const isRemote = (url: string) => /^(https?:)?\/\//i.test(url.trim());
  const fixUrl = (url: string): string | null => {
    const u = url.trim();
    if (/^cid:/i.test(u)) {
      const id = cidMap.get(u.slice(4).replace(/[<>]/g, '').toLowerCase());
      return id ? `/api/attachments/${id}?inline=1` : '';
    }
    if (isRemote(u) && !opts.allowRemote) {
      blocked++;
      return null;
    }
    return u;
  };

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (el.tagName === 'IMG' || el.tagName === 'IMAGE') {
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
    let clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: false,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base'],
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
    }
    return { html: clean, blockedImages: blocked };
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/** Plain-text bodies: escape, linkify, and style quoted lines. */
export function textToSafeHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = esc.replace(/\bhttps?:\/\/[^\s<>"')]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`);
  return `<div style="white-space:pre-wrap;word-break:break-word;font-family:inherit">${linked}</div>`;
}
