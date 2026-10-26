import { get } from '../db/index.js';
import { domainOf } from '../lib/addr.js';
import { escapeHtml } from './compose.js';

/**
 * A domain's footer (a disclaimer, say): plain text an administrator sets, added
 * once to the end of the mail people send from the domain. sendDraft is the one
 * path user mail takes (web compose, the API, JMAP, scheduled sends); system mail
 * builds its own messages and never gets one.
 */
export const FOOTER_MAX = 2000;

export function domainFooter(fromAddress: string): string | null {
  const row = get<{ footer_text: string | null }>('SELECT footer_text FROM domains WHERE name = ?', [domainOf(fromAddress)]);
  return row?.footer_text?.trim() ? row.footer_text : null;
}

const PGP_ARMOR = /-----BEGIN PGP (?:MESSAGE|SIGNED MESSAGE)-----/;
const PGP_MIME = /^application\/pgp-(?:encrypted|signature)$/i;

/** Signed or encrypted mail (inline or PGP/MIME) is sent untouched: a footer would break the signature or sit outside the encryption. */
export function isPgp(m: { pgp_sign?: number | null; text_body: string | null; html_body: string | null }, attachments: { content_type: string }[]): boolean {
  return !!m.pgp_sign || PGP_ARMOR.test(m.text_body ?? '') || PGP_ARMOR.test(m.html_body ?? '') || attachments.some((a) => PGP_MIME.test(a.content_type));
}

export function footerHtml(footer: string): string {
  return `<hr style="border:0;border-top:1px solid #dadce0;margin:24px 0 8px"><div style="font-size:12px;line-height:1.4;color:#5f6368">${escapeHtml(footer).replace(/\n/g, '<br>')}</div>`;
}

export const footerText = (footer: string) => `\n\n${footer}`;

/** The body with the footer at its end (before </body> in a whole HTML document). */
export function addFooter(body: { html: string | null; text: string }, footer: string): { html: string | null; text: string } {
  let html = body.html;
  if (html) {
    const end = html.search(/<\/body\s*>(?![\s\S]*<\/body)/i);
    html = end === -1 ? html + footerHtml(footer) : html.slice(0, end) + footerHtml(footer) + html.slice(end);
  }
  return { html, text: body.text + footerText(footer) };
}

/** Undo addFooter on a stored body (undo send turns the message back into a draft). */
export function removeFooter(body: { html: string | null; text: string | null }, footer: string): { html: string | null; text: string | null } {
  const block = footerHtml(footer);
  const tail = footerText(footer);
  const at = body.html ? body.html.lastIndexOf(block) : -1;
  return {
    html: at === -1 ? body.html : body.html!.slice(0, at) + body.html!.slice(at + block.length),
    text: body.text?.endsWith(tail) ? body.text.slice(0, -tail.length) : body.text,
  };
}
