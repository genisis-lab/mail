import type { Context } from 'hono';

/**
 * Everything that differs between runtimes lives behind this interface.
 * The Node entry (src/server/index.ts) and the Cloudflare Workers entry
 * (src/worker/index.ts) each provide an implementation.
 */

/** Synchronous SQLite access — better-sqlite3 on Node, Durable Object SQL on Workers. */
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

/** A plain or TLS TCP connection (used by the SMTP client). */
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
  name: 'node' | 'workers';
  blobs: BlobStore;
  dns: DnsResolver;
  clientIp(c: Context): string;
  /** Size of the database in bytes. */
  databaseSize(): number;
  /** Runtime details for the admin "System" page. */
  systemInfo(): Record<string, unknown>;
  /** Raw SQLite file snapshot (Node only; every runtime also has the portable export). */
  snapshot?(): Promise<{ data: Uint8Array; filename: string; contentType: string }>;
  /** Ask the runtime to run background work no later than `at` (Workers alarms). */
  wake?(at: number): void;
  /** Send raw MIME through a Workers `send_email` binding (Workers only). */
  sendViaBinding?(binding: string, from: string, to: string, raw: Uint8Array): Promise<void>;
  /** Durable Object point-in-time recovery (Workers only). */
  pointInTime?: {
    /** Bookmark for the current state. */
    current(): Promise<string>;
    /** Bookmark for a moment in the last 30 days. */
    at(timestamp: number): Promise<string>;
    /** Restore the whole database to a bookmark. The object restarts shortly after. */
    restore(bookmark: string): Promise<void>;
  };
  /** Outbound TCP (SMTP relays): net/tls on Node, cloudflare:sockets on Workers. */
  tcp?: TcpConnector;
  /** Runtime bindings / environment (Workers env). */
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
