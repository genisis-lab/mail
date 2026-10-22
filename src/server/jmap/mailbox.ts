/**
 * Mailbox/* (RFC 8621 section 2). Wren's six folders are mailboxes with roles,
 * and its labels are mailboxes without one. An email is always in exactly one
 * folder and in any number of labels, the way Gmail works. Snoozed mail shows
 * in a Snoozed mailbox instead of its folder until it wakes.
 */
import { all, get, insert, now, run, tx } from '../db/index.js';
import { changesSince, checkState, currentState, hasChangesSince } from './changes.js';
import { MethodError, SetError, asSetError } from './errors.js';
import { FOLDER_MAILBOXES, labelMailboxId, parseLabelId } from './ids.js';
import { CAP, checkSetSize, getIds, getProperties, isObject, method, pick, resolveId, type JmapContext } from './request.js';

const PROPS = ['name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads', 'myRights', 'isSubscribed'] as const;
const COUNTS = ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];

/** The folder mailbox an email shows in: a snoozed email waits in Snoozed until it wakes. */
export const MAILBOX_OF_ROW = `CASE WHEN m.snoozed_until IS NOT NULL AND m.folder IN ('inbox','archive') THEN 'snoozed' WHEN m.folder = 'spam' THEN 'junk' ELSE m.folder END`;

interface Counts {
  total: number;
  unread: number;
  threads: number;
  unreadThreads: number;
}

const rights = (label: boolean) => ({
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: false,
  mayRename: label,
  mayDelete: label,
  maySubmit: true,
});

/** Every mailbox of the user, with counts. */
export function listMailboxes(userId: number): Record<string, unknown>[] {
  const folderCounts = new Map(
    all<Counts & { mb: string }>(
      `SELECT ${MAILBOX_OF_ROW} AS mb, COUNT(*) AS total, SUM(m.is_read = 0) AS unread, COUNT(DISTINCT m.thread_id) AS threads,
              COUNT(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unreadThreads
         FROM messages m WHERE m.user_id = ? GROUP BY mb`,
      [userId],
    ).map((r) => [r.mb, r]),
  );
  const labelCounts = new Map(
    all<Counts & { label_id: number }>(
      `SELECT ml.label_id, COUNT(*) AS total, SUM(m.is_read = 0) AS unread, COUNT(DISTINCT m.thread_id) AS threads,
              COUNT(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unreadThreads
         FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.user_id = ? GROUP BY ml.label_id`,
      [userId],
    ).map((r) => [r.label_id, r]),
  );
  const counts = (c: Counts | undefined) => ({
    totalEmails: c?.total ?? 0,
    unreadEmails: c?.unread ?? 0,
    totalThreads: c?.threads ?? 0,
    unreadThreads: c?.unreadThreads ?? 0,
  });
  const out: Record<string, unknown>[] = FOLDER_MAILBOXES.map((f) => ({
    id: f.id,
    name: f.name,
    parentId: null,
    role: f.role,
    sortOrder: f.sortOrder,
    ...counts(folderCounts.get(f.id)),
    myRights: rights(false),
    isSubscribed: true,
  }));
  for (const l of all<{ id: number; name: string; position: number; created_at: number }>('SELECT id, name, position, created_at FROM labels WHERE user_id = ? ORDER BY position, name COLLATE NOCASE', [userId])) {
    out.push({
      id: labelMailboxId(l),
      name: l.name,
      parentId: null,
      role: null,
      sortOrder: 10 + l.position,
      ...counts(labelCounts.get(l.id)),
      myRights: rights(true),
      isSubscribed: true,
    });
  }
  return out;
}

/** A label of this user from a mailbox id (null for folders and unknown ids). */
export function labelFor(userId: number, id: unknown): { id: number; name: string } | null {
  const key = parseLabelId(id);
  if (!key) return null;
  return get<{ id: number; name: string }>('SELECT id, name FROM labels WHERE id = ? AND user_id = ? AND created_at = ?', [key.id, userId, key.createdAt]) ?? null;
}

method('Mailbox/get', CAP.mail, (args, ctx) => {
  const ids = getIds(args, ctx, true);
  const props = getProperties(args, PROPS);
  const state = currentState(ctx.user.id);
  const boxes = listMailboxes(ctx.user.id);
  const byId = new Map(boxes.map((b) => [b.id as string, b]));
  const list = ids ? ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!) : boxes;
  return {
    accountId: ctx.accountId,
    state,
    list: list.map((b) => pick(b, props)),
    notFound: ids ? ids.filter((id) => !byId.has(id)) : [],
  };
});

method('Mailbox/changes', CAP.mail, (args, ctx) => {
  const own = changesSince(ctx.user.id, 'Mailbox', args.sinceState);
  // Counts change with every email change: report every mailbox as updated, with only the counts when nothing else changed.
  const emailsChanged = hasChangesSince(ctx.user.id, 'Email', args.sinceState);
  const created = new Set(own.created);
  const destroyed = new Set(own.destroyed);
  const updated = new Set(own.updated);
  if (emailsChanged) for (const b of listMailboxes(ctx.user.id)) if (!created.has(b.id as string)) updated.add(b.id as string);
  const total = created.size + updated.size + destroyed.size;
  if (args.maxChanges && total > args.maxChanges) throw new MethodError('cannotCalculateChanges', 'Too many changes; sync mailboxes again');
  return {
    accountId: ctx.accountId,
    oldState: own.oldState,
    newState: own.newState,
    hasMoreChanges: false,
    created: [...created],
    updated: [...updated],
    destroyed: [...destroyed],
    updatedProperties: emailsChanged && !own.created.length && !own.updated.length && !own.destroyed.length ? COUNTS : null,
  };
});

method('Mailbox/query', CAP.mail, (args, ctx) => {
  let boxes = listMailboxes(ctx.user.id);
  const filter = args.filter ?? null;
  if (filter !== null) {
    if (!isObject(filter)) throw new MethodError('invalidArguments', 'filter must be an object');
    for (const [k, v] of Object.entries(filter)) {
      if (k === 'parentId') boxes = boxes.filter((b) => b.parentId === v);
      else if (k === 'name') boxes = boxes.filter((b) => String(b.name).toLowerCase().includes(String(v).toLowerCase()));
      else if (k === 'role') boxes = boxes.filter((b) => b.role === v);
      else if (k === 'hasAnyRole') boxes = boxes.filter((b) => (b.role !== null) === !!v);
      else if (k === 'isSubscribed') boxes = boxes.filter(() => !!v);
      else throw new MethodError('unsupportedFilter', `Unsupported filter ${k}`);
    }
  }
  const sort = Array.isArray(args.sort) ? args.sort : [{ property: 'sortOrder' }];
  for (const c of [...sort].reverse()) {
    const prop = c?.property;
    if (prop !== 'sortOrder' && prop !== 'name') throw new MethodError('unsupportedSort', `Can't sort by ${String(prop)}`);
    const dir = c.isAscending === false ? -1 : 1;
    boxes.sort((a, b) => (prop === 'name' ? String(a.name).localeCompare(String(b.name)) : (a.sortOrder as number) - (b.sortOrder as number)) * dir);
  }
  const position = Math.max(0, Number(args.position) || 0);
  const limit = args.limit === undefined || args.limit === null ? boxes.length : Math.max(0, Number(args.limit));
  return {
    accountId: ctx.accountId,
    queryState: currentState(ctx.user.id),
    canCalculateChanges: false,
    position,
    ids: boxes.slice(position, position + limit).map((b) => b.id),
    total: boxes.length,
  };
});

method('Mailbox/queryChanges', CAP.mail, () => {
  throw new MethodError('cannotCalculateChanges', 'Run Mailbox/query again');
});

function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 80) throw new SetError('invalidProperties', 'A mailbox name has 1 to 80 characters', { properties: ['name'] });
  if (FOLDER_MAILBOXES.some((f) => f.name.toLowerCase() === n.toLowerCase())) throw new SetError('invalidProperties', `${n} is a built-in mailbox`, { properties: ['name'] });
  return n;
}

function checkFixed(obj: Record<string, unknown>) {
  if (obj.parentId !== undefined && obj.parentId !== null) throw new SetError('invalidProperties', 'Mailboxes can’t be nested here', { properties: ['parentId'] });
  if (obj.role !== undefined && obj.role !== null) throw new SetError('invalidProperties', 'Only the built-in mailboxes have roles', { properties: ['role'] });
  const known = new Set(['name', 'parentId', 'role', 'sortOrder', 'isSubscribed']);
  const bad = Object.keys(obj).filter((k) => !known.has(k));
  if (bad.length) throw new SetError('invalidProperties', `Can’t set ${bad.join(', ')}`, { properties: bad });
}

const LABEL_COLOR = '#64748b';

method('Mailbox/set', CAP.mail, (args, ctx: JmapContext) => {
  checkSetSize(args);
  const userId = ctx.user.id;
  checkState(userId, args.ifInState);
  const oldState = currentState(userId);
  const created: Record<string, unknown> = {};
  const updated: Record<string, null> = {};
  const destroyed: string[] = [];
  const notCreated: Record<string, unknown> = {};
  const notUpdated: Record<string, unknown> = {};
  const notDestroyed: Record<string, unknown> = {};

  for (const [cid, obj] of Object.entries<Record<string, unknown>>(args.create ?? {})) {
    try {
      if (!isObject(obj)) throw new SetError('invalidProperties', 'Not an object');
      checkFixed(obj);
      const name = validName(obj.name);
      if (get('SELECT 1 FROM labels WHERE user_id = ? AND lower(name) = lower(?)', [userId, name])) throw new SetError('alreadyExists', 'A mailbox with that name exists');
      const position = typeof obj.sortOrder === 'number' ? Math.max(0, Math.floor(obj.sortOrder) - 10) : 0;
      const ts = now();
      const id = insert('INSERT INTO labels (user_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?)', [userId, name, LABEL_COLOR, position, ts]);
      const mailboxId = labelMailboxId({ id, created_at: ts });
      ctx.createdIds.set(cid, mailboxId);
      created[cid] = { id: mailboxId, role: null, sortOrder: 10 + position, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rights(true), isSubscribed: true };
    } catch (err) {
      notCreated[cid] = asSetError(err);
    }
  }

  for (const [rawId, patch] of Object.entries<Record<string, unknown>>(args.update ?? {})) {
    const id = String(resolveId(ctx, rawId));
    try {
      if (FOLDER_MAILBOXES.some((f) => f.id === id)) {
        // A client may write back what it read; anything else is a change to a built-in mailbox.
        const box = FOLDER_MAILBOXES.find((f) => f.id === id)!;
        const same = Object.entries(patch ?? {}).every(([k, v]) => (k === 'isSubscribed' && v === true) || (k === 'name' && v === box.name) || (k === 'sortOrder' && v === box.sortOrder));
        if (!same) throw new SetError('forbidden', 'Built-in mailboxes can’t be changed');
        updated[id] = null;
        continue;
      }
      const label = labelFor(userId, id);
      if (!label) throw new SetError('notFound', 'No such mailbox');
      if (!isObject(patch)) throw new SetError('invalidPatch', 'Not an object');
      checkFixed(patch);
      if (patch.name !== undefined) {
        const name = validName(patch.name);
        if (get('SELECT 1 FROM labels WHERE user_id = ? AND lower(name) = lower(?) AND id <> ?', [userId, name, label.id])) throw new SetError('alreadyExists', 'A mailbox with that name exists');
        run('UPDATE labels SET name = ? WHERE id = ?', [name, label.id]);
      }
      if (typeof patch.sortOrder === 'number') run('UPDATE labels SET position = ? WHERE id = ?', [Math.max(0, Math.floor(patch.sortOrder) - 10), label.id]);
      updated[id] = null;
    } catch (err) {
      notUpdated[id] = asSetError(err);
    }
  }

  for (const rawId of (args.destroy ?? []) as unknown[]) {
    const id = String(resolveId(ctx, rawId));
    try {
      if (FOLDER_MAILBOXES.some((f) => f.id === id)) throw new SetError('forbidden', 'Built-in mailboxes can’t be deleted');
      const label = labelFor(userId, id);
      if (!label) throw new SetError('notFound', 'No such mailbox');
      // Emails keep their folder, so removing a label never leaves one without a mailbox.
      if (!args.onDestroyRemoveEmails && get('SELECT 1 FROM message_labels WHERE label_id = ? LIMIT 1', [label.id])) {
        throw new SetError('mailboxHasEmail', 'The mailbox still has email in it');
      }
      tx(() => run('DELETE FROM labels WHERE id = ?', [label.id]));
      destroyed.push(id);
    } catch (err) {
      notDestroyed[id] = asSetError(err);
    }
  }

  return { accountId: ctx.accountId, oldState, newState: currentState(userId), created, updated, destroyed, notCreated, notUpdated, notDestroyed };
});
