import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqlDriver } from '../src/server/platform';

/**
 * Node's built-in SQLite stands in for Durable Object SQLite in tests
 * (wrap it with withDurableObjectLimits to enforce the Durable Object limits).
 */
export function nodeSqlDriver(file: string): SqlDriver {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  return {
    all: (sql, params) => stmt(sql).all(...(params as never[])),
    run: (sql, params) => {
      const r = stmt(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    exec: (sql) => db.exec(sql),
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
