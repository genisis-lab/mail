/**
 * JMAP ids. They match the ones the change-log triggers write (migration 13):
 *
 *   Email    M{message id}T{thread id}C{created_at}[V{draft revision}]
 *   Thread   T{thread id}C{created_at}
 *   Mailbox  inbox, archive, sent, drafts, junk, trash (folders) or L{label id}C{created_at}
 *   Blob     R{message}C{created_at}[V{rev}] (the raw message), A{attachment id},
 *            P{message}C{created_at}[V{rev}]t|h (the text or HTML body)
 *   Account  u{user id}
 *
 * created_at keeps a deleted object's id from coming back when SQLite reuses
 * its rowid. JMAP emails are immutable and never change thread, so moving an
 * email to another thread (merging conversations) or editing a draft gives it
 * a new id: the old one is destroyed and the new one created.
 */
import type { Folder } from '../../shared/types.js';

export interface EmailKey {
  id: number;
  threadId: number;
  createdAt: number;
  rev: number;
}

export const emailId = (r: { id: number; thread_id: number; created_at: number; jmap_rev: number }) =>
  `M${r.id}T${r.thread_id}C${r.created_at}${r.jmap_rev > 0 ? `V${r.jmap_rev}` : ''}`;

export function parseEmailId(id: unknown): EmailKey | null {
  const m = typeof id === 'string' ? /^M(\d{1,15})T(\d{1,15})C(\d{1,15})(?:V(\d{1,9}))?$/.exec(id) : null;
  return m ? { id: Number(m[1]), threadId: Number(m[2]), createdAt: Number(m[3]), rev: Number(m[4] ?? 0) } : null;
}

export const threadId = (r: { id: number; created_at: number }) => `T${r.id}C${r.created_at}`;

export function parseThreadId(id: unknown): { id: number; createdAt: number } | null {
  const m = typeof id === 'string' ? /^T(\d{1,15})C(\d{1,15})$/.exec(id) : null;
  return m ? { id: Number(m[1]), createdAt: Number(m[2]) } : null;
}

/** The six folders, as JMAP mailboxes with roles. Wren's "spam" folder is JMAP's "junk". */
export const FOLDER_MAILBOXES: { id: string; folder: Folder; role: string; name: string; sortOrder: number }[] = [
  { id: 'inbox', folder: 'inbox', role: 'inbox', name: 'Inbox', sortOrder: 1 },
  { id: 'archive', folder: 'archive', role: 'archive', name: 'Archive', sortOrder: 2 },
  { id: 'drafts', folder: 'drafts', role: 'drafts', name: 'Drafts', sortOrder: 3 },
  { id: 'sent', folder: 'sent', role: 'sent', name: 'Sent', sortOrder: 4 },
  { id: 'junk', folder: 'spam', role: 'junk', name: 'Spam', sortOrder: 5 },
  { id: 'trash', folder: 'trash', role: 'trash', name: 'Trash', sortOrder: 6 },
];

export const folderMailbox = (folder: Folder) => FOLDER_MAILBOXES.find((f) => f.folder === folder)!.id;
export const mailboxFolder = (id: string): Folder | null => FOLDER_MAILBOXES.find((f) => f.id === id)?.folder ?? null;

export const labelMailboxId = (r: { id: number; created_at: number }) => `L${r.id}C${r.created_at}`;

export function parseLabelId(id: unknown): { id: number; createdAt: number } | null {
  const m = typeof id === 'string' ? /^L(\d{1,15})C(\d{1,15})$/.exec(id) : null;
  return m ? { id: Number(m[1]), createdAt: Number(m[2]) } : null;
}

export type BlobRef =
  | { kind: 'raw'; messageId: number; createdAt: number; rev: number }
  | { kind: 'attachment'; attachmentId: number }
  | { kind: 'part'; messageId: number; createdAt: number; rev: number; part: 'text' | 'html' };

// A blob's bytes never change, so a draft's raw message and body parts are named after its revision too.
const version = (r: { id: number; created_at: number; jmap_rev: number }) => `${r.id}C${r.created_at}${r.jmap_rev > 0 ? `V${r.jmap_rev}` : ''}`;
export const rawBlobId = (r: { id: number; created_at: number; jmap_rev: number }) => `R${version(r)}`;
export const partBlobId = (r: { id: number; created_at: number; jmap_rev: number }, part: 't' | 'h') => `P${version(r)}${part}`;

export function parseBlobId(id: unknown): BlobRef | null {
  if (typeof id !== 'string') return null;
  let m = /^R(\d{1,15})C(\d{1,15})(?:V(\d{1,9}))?$/.exec(id);
  if (m) return { kind: 'raw', messageId: Number(m[1]), createdAt: Number(m[2]), rev: Number(m[3] ?? 0) };
  m = /^A(\d{1,15})$/.exec(id);
  if (m) return { kind: 'attachment', attachmentId: Number(m[1]) };
  m = /^P(\d{1,15})C(\d{1,15})(?:V(\d{1,9}))?([th])$/.exec(id);
  if (m) return { kind: 'part', messageId: Number(m[1]), createdAt: Number(m[2]), rev: Number(m[3] ?? 0), part: m[4] === 't' ? 'text' : 'html' };
  return null;
}

export const accountId = (userId: number) => `u${userId}`;
