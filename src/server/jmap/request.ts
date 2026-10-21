/**
 * The JMAP request envelope (RFC 8620 section 3): capabilities, method calls,
 * result references ("#ids" pointing at an earlier call's result) and
 * creation ids ("#k1" standing for an object created earlier in the request).
 */
import { all } from '../db/index.js';
import { HttpError } from '../lib/http.js';
import { logger } from '../lib/log.js';
import type { UserRow } from '../services/users.js';
import { MethodError, problem } from './errors.js';
import { accountId } from './ids.js';

const log = logger('jmap');

export const CAP = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  quota: 'urn:ietf:params:jmap:quota',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
  /**
   * Fastmail's mail extension (Cyrus IMAP's JMAP_MAIL_EXTENSION, which lists "snoozed" among its
   * "FM extensions"). Wren supports only its Email "snoozed" property; see email.ts.
   */
  snooze: 'https://cyrusimap.org/ns/jmap/mail',
} as const;

/** What a shared mailbox's account offers (it has no quota or vacation reply of its own here). */
export const SHARED_CAPS: readonly string[] = [CAP.mail, CAP.submission, CAP.snooze];

export const LIMITS = {
  maxSizeRequest: 10_000_000,
  maxConcurrentUpload: 4,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
};

export interface JmapContext {
  /** The mailbox this call acts on: the signed-in person's own, or a shared mailbox they belong to. */
  user: UserRow;
  /** The person who is signed in (differs from `user` in a shared mailbox's account). */
  actor: UserRow;
  /** Whether the actor may send from `user` (members of a shared mailbox may not always). */
  canSend: boolean;
  /** The capabilities the request is using. */
  using: Set<string>;
  keyId: number;
  accountId: string;
  /** Creation id → server id, for "#creationId" references. */
  createdIds: Map<string, string>;
  /** Extra responses a method adds after its own (EmailSubmission/set's implicit Email/set). */
  extra: [string, unknown][];
  /** Every method call made so far in this request, so a method can call another (implicit calls). */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export type Handler = (args: Record<string, any>, ctx: JmapContext) => unknown | Promise<unknown>;

interface MethodDef {
  capability: string;
  handler: Handler;
  /** PushSubscription methods aren't tied to an account. */
  noAccount?: boolean;
}

const methods = new Map<string, MethodDef>();

export interface Account {
  box: UserRow;
  canSend: boolean;
}

/** The active shared mailboxes a person belongs to, each one an account in their mail apps. */
export function sharedAccounts(personId: number): Account[] {
  return all<UserRow & { can_send: number }>(
    `SELECT b.*, mm.can_send FROM mailbox_members mm JOIN users b ON b.id = mm.mailbox_id
      WHERE mm.user_id = ? AND b.kind = 'shared' AND b.status = 'active' ORDER BY b.email`,
    [personId],
  ).map(({ can_send, ...box }) => ({ box, canSend: !!can_send }));
}

/** The mailbox an account id names, if this person may use it right now (asked on every call, so losing access is immediate). */
export function accountFor(person: UserRow, id: unknown): Account | null {
  if (id === accountId(person.id)) return { box: person, canSend: true };
  return sharedAccounts(person.id).find((a) => accountId(a.box.id) === id) ?? null;
}

export function method(name: string, capability: string, handler: Handler, opts: { noAccount?: boolean } = {}) {
  methods.set(name, { capability, handler, noAccount: opts.noAccount });
}

/** Resolve "#creationId" to the id it was given earlier in the request. */
export function resolveId(ctx: JmapContext, id: unknown): unknown {
  if (typeof id === 'string' && id.startsWith('#')) return ctx.createdIds.get(id.slice(1)) ?? id;
  return id;
}

// ── Result references (RFC 8620 3.7) ────────────────────────────────────────

function walk(value: unknown, tokens: string[]): unknown {
  if (!tokens.length) return value;
  const [t, ...rest] = tokens;
  if (Array.isArray(value)) {
    if (t === '*') return value.flatMap((item) => {
      const r = walk(item, rest);
      return Array.isArray(r) ? r : [r];
    });
    if (!/^\d+$/.test(t) || Number(t) >= value.length) throw new MethodError('invalidResultReference', `No array element ${t}`);
    return walk(value[Number(t)], rest);
  }
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, t)) return walk((value as Record<string, unknown>)[t], rest);
  throw new MethodError('invalidResultReference', `Nothing at ${t}`);
}

export function evalPointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/')) throw new MethodError('invalidResultReference', 'A path must start with /');
  return walk(
    value,
    path
      .slice(1)
      .split('/')
      .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~')),
  );
}

function resolveReferences(args: Record<string, unknown>, responses: [string, unknown, string][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith('#')) {
      out[key] = value;
      continue;
    }
    const name = key.slice(1);
    if (name in args) throw new MethodError('invalidArguments', `Both ${name} and #${name} were given`);
    const ref = value as { resultOf?: unknown; name?: unknown; path?: unknown };
    if (!ref || typeof ref.resultOf !== 'string' || typeof ref.name !== 'string' || typeof ref.path !== 'string') {
      throw new MethodError('invalidResultReference', `#${name} is not a result reference`);
    }
    const source = responses.find(([n, , id]) => id === ref.resultOf && n === ref.name);
    if (!source) throw new MethodError('invalidResultReference', `No ${ref.name} response with id ${ref.resultOf}`);
    out[name] = evalPointer(source[1], ref.path);
  }
  return out;
}

// ── The request ─────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function processRequest(body: unknown, user: UserRow, keyId: number, sessionState: string): Promise<Response> {
  if (!isObject(body) || !Array.isArray(body.using) || !Array.isArray(body.methodCalls)) {
    return problem('notRequest', 'The request is not a JMAP Request object');
  }
  const using = new Set(body.using.filter((u): u is string => typeof u === 'string'));
  const known = new Set<string>(Object.values(CAP));
  const unknown = [...using].filter((u) => !known.has(u));
  if (unknown.length) return problem('unknownCapability', `Unsupported capability: ${unknown.join(', ')}`);
  if (body.methodCalls.length > LIMITS.maxCallsInRequest) return problem('limit', 'Too many method calls in one request', 400, { limit: 'maxCallsInRequest' });

  const responses: [string, unknown, string][] = [];
  const createdIds = new Map<string, string>(isObject(body.createdIds) ? Object.entries(body.createdIds).filter((e): e is [string, string] => typeof e[1] === 'string') : []);
  const ctx: JmapContext = {
    user,
    actor: user,
    canSend: true,
    using,
    keyId,
    accountId: accountId(user.id),
    createdIds,
    extra: [],
    async call(name, args) {
      const def = methods.get(name);
      if (!def) throw new MethodError('serverFail', `No method ${name}`);
      return def.handler(args, ctx);
    },
  };

  for (const callRaw of body.methodCalls) {
    if (!Array.isArray(callRaw) || callRaw.length !== 3 || typeof callRaw[0] !== 'string' || !isObject(callRaw[1]) || typeof callRaw[2] !== 'string') {
      return problem('notRequest', 'Each method call is [name, arguments, id]');
    }
    const [name, rawArgs, callId] = callRaw as [string, Record<string, unknown>, string];
    ctx.extra = [];
    try {
      const def = methods.get(name);
      if (!def || !using.has(def.capability)) throw new MethodError('unknownMethod', `Unknown method ${name}`);
      const args = resolveReferences(rawArgs, responses);
      const account = def.noAccount ? { box: user, canSend: true } : accountFor(user, args.accountId);
      if (!account) throw new MethodError('accountNotFound', 'No such account');
      if (account.box.id !== user.id && !SHARED_CAPS.includes(def.capability)) throw new MethodError('accountNotSupportedByMethod', 'Shared mailboxes don’t have this');
      ctx.user = account.box;
      ctx.canSend = account.canSend;
      ctx.accountId = accountId(account.box.id);
      const result = await def.handler(args, ctx);
      responses.push([name, result, callId]);
      for (const [n, r] of ctx.extra) responses.push([n, r, callId]);
    } catch (err) {
      responses.push(['error', methodError(err, name), callId]);
    }
  }

  const response: Record<string, unknown> = { methodResponses: responses, sessionState };
  if (isObject(body.createdIds)) response.createdIds = Object.fromEntries(createdIds);
  return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function methodError(err: unknown, name: string) {
  if (err instanceof MethodError) return err.toJSON();
  if (err instanceof HttpError && err.status < 500) return { type: 'invalidArguments', description: err.message };
  log.error(`${name} failed`, err);
  return { type: 'serverFail', description: 'Something went wrong on the server' };
}

// ── Helpers shared by the method handlers ───────────────────────────────────

/** ids for /get: null means all (only where the type allows it); otherwise a bounded array of strings. */
export function getIds(args: Record<string, any>, ctx: JmapContext, allowAll: boolean): string[] | null {
  if (args.ids === undefined || args.ids === null) {
    if (allowAll) return null;
    throw new MethodError('requestTooLarge', 'Ask for specific ids');
  }
  if (!Array.isArray(args.ids) || args.ids.some((i: unknown) => typeof i !== 'string')) throw new MethodError('invalidArguments', 'ids must be an array of strings');
  if (args.ids.length > LIMITS.maxObjectsInGet) throw new MethodError('requestTooLarge', `At most ${LIMITS.maxObjectsInGet} ids per call`);
  return args.ids.map((i: string) => String(resolveId(ctx, i)));
}

/** properties for /get, checked against the type's known properties. "id" is always returned. */
export function getProperties(args: Record<string, any>, known: readonly string[], defaults: readonly string[] = known): Set<string> {
  if (args.properties === undefined || args.properties === null) return new Set(['id', ...defaults]);
  if (!Array.isArray(args.properties)) throw new MethodError('invalidArguments', 'properties must be an array');
  const props = new Set<string>(['id']);
  for (const p of args.properties) {
    if (typeof p !== 'string' || (!known.includes(p) && !p.startsWith('header:'))) throw new MethodError('invalidArguments', `Unknown property ${String(p)}`);
    props.add(p);
  }
  return props;
}

/** Pick the requested properties from a full object. */
export function pick(obj: Record<string, unknown>, props: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of props) if (p in obj) out[p] = obj[p];
  return out;
}

/** The size of a /set call. */
export function checkSetSize(args: Record<string, any>) {
  const n = Object.keys(args.create ?? {}).length + Object.keys(args.update ?? {}).length + (Array.isArray(args.destroy) ? args.destroy.length : 0);
  if (n > LIMITS.maxObjectsInSet) throw new MethodError('requestTooLarge', `At most ${LIMITS.maxObjectsInSet} changes per call`);
  for (const k of ['create', 'update'] as const) if (args[k] !== undefined && args[k] !== null && !isObject(args[k])) throw new MethodError('invalidArguments', `${k} must be an object`);
  if (args.destroy !== undefined && args.destroy !== null && !Array.isArray(args.destroy)) throw new MethodError('invalidArguments', 'destroy must be an array');
}

/** Apply a JMAP PatchObject ("a/b": value) to a plain object. Only one level of path is allowed below the property. */
export function applyPatch(target: Record<string, any>, patch: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = structuredClone(target);
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.length === 1) {
      out[parts[0]] = value;
    } else if (parts.length === 2) {
      const obj = out[parts[0]];
      if (!isObject(obj)) throw new MethodError('invalidPatch', `${parts[0]} is not an object`);
      if (value === null) delete obj[parts[1]];
      else obj[parts[1]] = value;
    } else {
      throw new MethodError('invalidPatch', `Unsupported patch path ${path}`);
    }
  }
  return out;
}

export { isObject };
