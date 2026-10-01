import { getBlob, putBlob } from './blobs.js';
import { htmlToText } from './parse.js';

/**
 * Message bodies normally live in the `messages` row. Very large ones (huge
 * newsletters, replies quoting them) move to blob storage, because a
 * Durable Object SQLite row is capped at 2 MB. The row keeps a text prefix so
 * full-text search and snippets still work.
 */
const INLINE_LIMIT = 256 * 1024;
const SEARCH_PREFIX = 100_000;

const bytes = (s: string | null | undefined) => (s ? (s.length * 3 <= INLINE_LIMIT ? s.length : new TextEncoder().encode(s).length) : 0);

export interface BodyColumns {
  text_body: string | null;
  html_body: string | null;
  body_blob: string | null;
}

export async function bodyColumns(text: string | null, html: string | null): Promise<BodyColumns> {
  if (bytes(text) + bytes(html) <= INLINE_LIMIT) return { text_body: text, html_body: html, body_blob: null };
  const blob = await putBlob(new TextEncoder().encode(JSON.stringify({ text, html })));
  const prefix = (text ?? (html ? htmlToText(html) : '')).slice(0, SEARCH_PREFIX);
  return { text_body: prefix, html_body: null, body_blob: blob };
}

/** Replace the row's inline body columns with the full body when it was stored externally. */
export async function loadBody<T extends { text_body: string | null; html_body: string | null; body_blob?: string | null }>(row: T): Promise<T> {
  if (!row.body_blob) return row;
  try {
    const body = JSON.parse(new TextDecoder().decode(await getBlob(row.body_blob))) as { text: string | null; html: string | null };
    row.text_body = body.text;
    row.html_body = body.html;
  } catch {
    // Keep the stored prefix if the blob is unavailable.
  }
  return row;
}
