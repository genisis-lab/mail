// Minimal ambient types for the Cloudflare Workers runtime modules used by Wren.
// (Kept local so the project needs a single tsconfig shared with the DOM build.)

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: ReadableStream | string);
    readonly from: string;
    readonly to: string;
  }
}

interface SqlStorageCursor<T = Record<string, unknown>> {
  toArray(): T[];
  one(): T;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  readonly databaseSize: number;
}

interface DurableObjectStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number | Date): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil(p: Promise<unknown>): void;
}

interface DurableObjectId {}
interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
  [method: string]: any;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
}
interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
  list(opts?: { cursor?: string; limit?: number; prefix?: string }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  readonly headers: Headers;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface Fetcher {
  fetch(req: Request): Promise<Response>;
}

interface SendEmail {
  send(message: unknown): Promise<unknown>;
}
