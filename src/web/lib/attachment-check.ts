/**
 * "Did you mean to attach files?": like Gmail, warn before sending a message
 * that says "see attached" (or "I've enclosed", "PFA"…) but has no files.
 * Only the text the person wrote counts, not the quoted message or signature.
 */

// The word, plus the word before it for context ("see attached").
const MENTION = /(?:[\p{L}'’]+\s+)?\b(attach(?:ed|ing|ments?)?|enclosed|enclosing|pfa)\b/iu;

/** The phrase that promises an attachment, or null. A reply's or forward's subject came from the original, so it's ignored. */
export function mentionsAttachment(subject: string, text: string): string | null {
  const own = /^\s*(re|fwd?|aw|wg|tr)\s*:/i.test(subject) ? '' : subject;
  for (const source of [text, own]) {
    const m = MENTION.exec(source);
    if (m) return m[0].trim();
  }
  return null;
}

/** What the person wrote in the editor, without quoted mail, forwarded content or their signature. */
export function ownText(html: string): string {
  // An inert document: nothing in quoted mail loads or runs.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('.wren-quote, .wren-forward, .wren-signature, blockquote').forEach((n) => n.remove());
  return doc.body.textContent ?? '';
}
