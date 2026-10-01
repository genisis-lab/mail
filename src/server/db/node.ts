import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { SqlDriver } from '../platform.js';

/** better-sqlite3 driver for Node.js. */
export function nodeSqlDriver(file: string): SqlDriver & { db: Database.Database } {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  const cache = new Map<string, Database.Statement>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    db,
    all: (sql, params) => {
      const s = stmt(sql);
      return s.reader ? s.all(...params) : (s.run(...params), []);
    },
    run: (sql, params) => {
      const r = stmt(sql).run(...params);
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn)(),
  };
}
