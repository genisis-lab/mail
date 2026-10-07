/**
 * One-time codes in incoming mail ("980708 is your Whop sign-in code"), so the
 * inbox, the message and the notification can offer a one-tap copy.
 *
 * It looks for a 4–8 digit code (or two groups like "123 456" / "123-456")
 * next to a word that says it's a code. Years, prices, phone numbers and
 * order numbers without such a word are left alone.
 */

const KEYWORDS =
  /\b(codes?|passcodes?|pass codes?|otp|one[- ]time|verification|verify|confirmation|security|sign[- ]?in|log[- ]?in|2fa|two[- ]factor|authenticat\w*|pin|token|código|code de|bestätigungscode)\b/i;
const CODE = /(?<![\w.,$£€-])(\d{3}[ -]\d{3}|\d{4,8})(?![\w%]|[.,]\d)/g;

/** `before`: the text just before the number. */
function plausible(code: string, before: string): boolean {
  const digits = code.replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 8) return false;
  // A 4-digit year ("© 2026", "the 2026 conference") is only a code right after "code" or "PIN".
  if (digits.length === 4 && /^(19|20)\d\d$/.test(digits) && !/\b(code|pin|passcode)\b\W{0,12}$/i.test(before)) return false;
  return true;
}

/** The code, digits only ("980708"), or null. */
export function findOneTimeCode(subject: string, text: string | null): string | null {
  // The subject first: "980708 is your Whop sign-in code", "Your code: 4821".
  if (KEYWORDS.test(subject)) {
    for (const m of subject.matchAll(CODE)) if (plausible(m[1], subject.slice(0, m.index))) return m[1].replace(/\D/g, '');
  }
  const body = (text ?? '').slice(0, 3000);
  if (!KEYWORDS.test(subject) && !KEYWORDS.test(body)) return null;
  // In the body, prefer a code that sits near one of the words (within a short window)…
  for (const m of body.matchAll(CODE)) {
    const at = m.index ?? 0;
    const near = body.slice(Math.max(0, at - 90), at + m[0].length + 60);
    if (KEYWORDS.test(near) && plausible(m[1], body.slice(Math.max(0, at - 40), at))) return m[1].replace(/\D/g, '');
  }
  // …or, when the subject already says it's a code ("Your verification code"), the first one.
  if (KEYWORDS.test(subject)) {
    for (const m of body.matchAll(CODE)) if (plausible(m[1], body.slice(Math.max(0, (m.index ?? 0) - 40), m.index))) return m[1].replace(/\D/g, '');
  }
  return null;
}
