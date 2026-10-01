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
  delete(key: string): Promise<void>;
  /** Iterate all stored blobs (used by garbage collection and size stats). */
  list(): AsyncIterable<{ key: string; size: number; uploaded: number }>;
}

export interface DnsResolver {
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  cname(name: string): Promise<string[]>;
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
  /** Full database snapshot for download. */
  backup(): Promise<{ data: Uint8Array; filename: string; contentType: string }>;
  /** Ask the runtime to run background work no later than `at` (Workers alarms). */
  wake?(at: number): void;
  /** Send raw MIME through a Workers `send_email` binding (Workers only). */
  sendViaBinding?(binding: string, from: string, to: string, raw: Uint8Array): Promise<void>;
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
