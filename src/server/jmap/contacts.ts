/**
 * JMAP Contacts (RFC 9610), read only: the people Wren suggests as you type.
 * Two address books: "contacts" (the ones you saved) and "recent" (people you've
 * written to, collected as you send). Contacts are edited in the web app.
 */
import { all } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { MethodError } from './errors.js';
import { CAP, getIds, getProperties, isObject, LIMITS, method, pick } from './request.js';

interface ContactRow {
  id: number;
  email: string;
  name: string;
  phone: string;
  company: string;
  notes: string;
  saved: number;
  created_at: number;
}

const BOOKS = [
  { id: 'contacts', name: 'Contacts', sortOrder: 0, isDefault: true },
  { id: 'recent', name: 'People you’ve written to', sortOrder: 1, isDefault: false },
];

const ORDER = 'ORDER BY saved DESC, times_contacted DESC, last_contacted_at DESC, id';
const cardId = (r: ContactRow) => `K${r.id}C${r.created_at}`;

/** A stable UUID for the card, so other systems can tell it's the same person. */
function uid(userId: number, email: string) {
  const h = sha256(`wren-contact:${userId}:${email.toLowerCase()}`);
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function card(userId: number, r: ContactRow): Record<string, unknown> {
  return {
    id: cardId(r),
    '@type': 'Card',
    version: '1.0',
    uid: uid(userId, r.email),
    kind: 'individual',
    addressBookIds: { [r.saved ? 'contacts' : 'recent']: true },
    name: r.name ? { '@type': 'Name', full: r.name } : null,
    emails: { e1: { '@type': 'EmailAddress', address: r.email } },
    phones: r.phone ? { p1: { '@type': 'Phone', number: r.phone } } : null,
    organizations: r.company ? { o1: { '@type': 'Organization', name: r.company } } : null,
    notes: r.notes ? { n1: { '@type': 'Note', note: r.notes } } : null,
  };
}

const CARD_PROPS = ['@type', 'version', 'uid', 'kind', 'addressBookIds', 'name', 'emails', 'phones', 'organizations', 'notes'];
const rows = (userId: number, where = '', params: unknown[] = []) =>
  all<ContactRow>(`SELECT id, email, name, phone, company, notes, saved, created_at FROM contacts WHERE user_id = ? ${where} ${ORDER}`, [userId, ...params]);

/** No change log for contacts: the state is a hash of them, and /changes only says whether anything changed. */
const cardState = (userId: number) => sha256(JSON.stringify(rows(userId).map((r) => [r.id, r.saved, r.email, r.name, r.phone, r.company, r.notes]))).slice(0, 16);
const bookState = sha256(JSON.stringify(BOOKS)).slice(0, 16);

function changes(args: Record<string, any>, ctx: { accountId: string }, state: string) {
  if (typeof args.sinceState !== 'string') throw new MethodError('invalidArguments', 'sinceState is required');
  if (args.sinceState !== state) throw new MethodError('cannotCalculateChanges', 'Get them again');
  return { accountId: ctx.accountId, oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
}

method('AddressBook/get', CAP.contacts, (args, ctx) => {
  const wanted = getIds(args, ctx, true);
  const props = getProperties(args, ['name', 'description', 'sortOrder', 'isDefault', 'isSubscribed', 'shareWith', 'myRights']);
  const full = BOOKS.map((b) => ({ ...b, description: null, isSubscribed: true, shareWith: null, myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false } }));
  return {
    accountId: ctx.accountId,
    state: bookState,
    list: full.filter((b) => !wanted || wanted.includes(b.id)).map((b) => pick(b, props)),
    notFound: (wanted ?? []).filter((id) => !BOOKS.some((b) => b.id === id)),
  };
});

method('AddressBook/changes', CAP.contacts, (args, ctx) => changes(args, ctx, bookState));

method('ContactCard/get', CAP.contacts, (args, ctx) => {
  const wanted = getIds(args, ctx, false)!;
  const props = getProperties(args, CARD_PROPS);
  const nums = wanted.map((id) => Number(/^K(\d{1,15})C\d{1,15}$/.exec(id)?.[1])).filter(Boolean);
  const byId = new Map(rows(ctx.user.id, 'AND id IN (SELECT value FROM json_each(?))', [JSON.stringify(nums)]).map((r) => [cardId(r), r]));
  const list: unknown[] = [];
  const notFound: string[] = [];
  for (const id of wanted) {
    const r = byId.get(id);
    if (r) list.push(pick(card(ctx.user.id, r), props));
    else notFound.push(id);
  }
  return { accountId: ctx.accountId, state: cardState(ctx.user.id), list, notFound };
});

method('ContactCard/changes', CAP.contacts, (args, ctx) => changes(args, ctx, cardState(ctx.user.id)));

const FILTERS = ['text', 'name', 'email', 'inAddressBook'];

method('ContactCard/query', CAP.contacts, (args, ctx) => {
  const filter: Record<string, string> = args.filter ?? {};
  if (!isObject(filter) || Object.keys(filter).some((k) => !FILTERS.includes(k) || typeof filter[k] !== 'string')) {
    throw new MethodError('unsupportedFilter', `Filter by ${FILTERS.join(', ')}, each a string`);
  }
  if (Array.isArray(args.sort) && args.sort.length) throw new MethodError('unsupportedSort', 'Cards come best match first: saved contacts, then the people you write to most');
  const where: string[] = [];
  const params: unknown[] = [];
  const match = (columns: string[], text: string) => {
    where.push(`(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...columns.map(() => `%${text.replace(/[\\%_]/g, '\\$&')}%`));
  };
  if (filter.text) match(['email', 'name', 'company'], filter.text);
  if (filter.name) match(['name'], filter.name);
  if (filter.email) match(['email'], filter.email);
  if (filter.inAddressBook) {
    where.push('saved = ?');
    params.push(({ contacts: 1, recent: 0 } as Record<string, number>)[filter.inAddressBook] ?? -1);
  }
  const ids = rows(ctx.user.id, where.map((w) => `AND ${w}`).join(' '), params).map(cardId);
  const position = Math.max(0, Number(args.position) || 0);
  const limit = Math.min(LIMITS.maxObjectsInGet, Number(args.limit) > 0 ? Number(args.limit) : LIMITS.maxObjectsInGet);
  return {
    accountId: ctx.accountId,
    queryState: cardState(ctx.user.id),
    canCalculateChanges: false,
    position,
    ids: ids.slice(position, position + limit),
    ...(args.calculateTotal ? { total: ids.length } : {}),
  };
});

method('ContactCard/queryChanges', CAP.contacts, () => {
  throw new MethodError('cannotCalculateChanges', 'Run ContactCard/query again');
});
