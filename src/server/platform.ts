/**
 * Storage, DNS, sockets and other runtime services. The Cloudflare Workers
 * entry (src/worker/index.ts) provides the implementation; tests provide an
 * in-process one (tests/node-platform.ts).
 */

/** Synchronous SQLite access (Durable Object SQL storage). */
export interface SqlDriver {
  all(sql: string, params: unknown[]): any[];
  run(sql: string, params: unknown[]): { changes: number; lastInsertRowid: number };
  /** Execute one or more statements without parameters (migrations). */
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Delete a batch of blobs (R2 accepts up to 1,000 keys per call). */
  delete(keys: string[]): Promise<void>;
  /** Iterate all stored blobs (used by garbage collection and size stats). */
  list(): AsyncIterable<{ key: string; size: number; uploaded: number }>;
}

export interface DnsResolver {
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  cname(name: string): Promise<string[]>;
}

/** A plain or TLS TCP connection (used by the SMTP relay client). */
export interface TcpSocket {
  /** Next chunk of data, or null once the peer closed the connection. */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** Upgrade the connection to TLS (STARTTLS). */
  startTls(): Promise<TcpSocket>;
  close(): Promise<void>;
}

export interface TcpConnector {
  connect(opts: { host: string; port: number; tls: boolean; starttls: boolean; allowSelfSigned: boolean }): Promise<TcpSocket>;
}

export interface Platform {
  blobs: BlobStore;
  dns: DnsResolver;
  /** Size of the database in bytes. */
  databaseSize(): number;
  /** Runtime details for the admin "System" page. */
  systemInfo(): Record<string, unknown>;
  /** Ask the runtime to run background work no later than `at` (Durable Object alarm). */
  wake?(at: number): void;
  /** Durable Object point-in-time recovery. */
  pointInTime?: {
    /** Bookmark for the current state. */
    current(): Promise<string>;
    /** Bookmark for a moment in the last 30 days. */
    at(timestamp: number): Promise<string>;
    /** Restore the whole database to a bookmark. The object restarts shortly after. */
    restore(bookmark: string): Promise<void>;
  };
  /** Outbound TCP for SMTP relays (`cloudflare:sockets`). */
  tcp?: TcpConnector;
  /** Send raw MIME through a `send_email` binding (Cloudflare Email Service). Returns the message id. */
  sendViaBinding?(binding: string, from: string, to: string, raw: Uint8Array): Promise<string | null>;
  /** Names of the configured send_email bindings. */
  emailBindings?(): string[];
  /** Worker env bindings. */
  env: Record<string, unknown>;
}

let current: Platform | null = null;

export function setPlatform(p: Platform) {
  current = p;
}

export function platform(): Platform {
  if (!current) throw new Error('Platform not initialised');
  return current;
}

export function hasPlatform(): boolean {
  return current !== null;
}
