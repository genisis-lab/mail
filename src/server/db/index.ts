import type { SqlDriver } from '../platform.js';
import { migrations } from './migrations.js';

type Params = unknown[];

let driver: SqlDriver | null = null;
let txDepth = 0;

/** Install a SQL driver and bring the schema up to date. */
export function openDb(d: SqlDriver) {
  driver = d;
  txDepth = 0;
  migrate();
}

export function closeDb() {
  driver = null;
}

function drv(): SqlDriver {
  if (!driver) throw new Error('Database not opened');
  return driver;
}

/** Split a migration script into individual statements (no semicolons inside our DDL strings). */
export function splitStatements(script: string): string[] {
  return script
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Schema version lives in a regular table so it works on every SQLite host. */
export function migrate() {
  const d = drv();
  d.exec('CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = d.all(`SELECT value FROM _meta WHERE key = 'schema_version'`, [])[0];
  const current = row ? Number(row.value) : 0;
  for (let v = current; v < migrations.length; v++) {
    d.transaction(() => {
      for (const stmt of splitStatements(migrations[v])) d.exec(stmt);
      d.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(v + 1)]);
    });
  }
}

function norm(params?: Params | Record<string, unknown>): unknown[] {
  if (params === undefined) return [];
  const list = Array.isArray(params) ? params : [params];
  return list.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

/** Return all rows. */
export function all<T = any>(sql: string, params?: Params): T[] {
  return drv().all(sql, norm(params)) as T[];
}

/** Return the first row or undefined. */
export function get<T = any>(sql: string, params?: Params): T | undefined {
  return drv().all(sql, norm(params))[0] as T | undefined;
}

/** Execute a write statement. */
export function run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  return drv().run(sql, norm(params));
}

/** Insert and return the new row id. */
export function insert(sql: string, params?: Params): number {
  return Number(run(sql, params).lastInsertRowid);
}

/** Run fn in a transaction. Nested calls join the outer transaction. */
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  txDepth++;
  try {
    return drv().transaction(fn);
  } finally {
    txDepth--;
  }
}

/** Build "?, ?, ?" for IN clauses. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export const now = () => Date.now();
