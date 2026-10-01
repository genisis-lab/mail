import type { SqlDriver } from '../src/server/platform';

/**
 * Wrap a SQL driver so tests fail where a SQLite Durable Object would:
 * at most 100 bound parameters, 100 KB statements and 2 MB values.
 */
export function withDurableObjectLimits(d: SqlDriver): SqlDriver {
  const check = (sql: string, params: unknown[]) => {
    if (params.length > 100) throw new Error(`too many SQL variables (${params.length}): ${sql.slice(0, 80)}`);
    if (sql.length > 100_000) throw new Error('statement too long');
    for (const p of params) {
      const size = typeof p === 'string' ? Buffer.byteLength(p) : p instanceof Uint8Array ? p.byteLength : 0;
      if (size > 2_000_000) throw new Error(`value too large (${size} bytes): ${sql.slice(0, 80)}`);
    }
  };
  return {
    all: (sql, params) => (check(sql, params), d.all(sql, params)),
    run: (sql, params) => (check(sql, params), d.run(sql, params)),
    exec: (sql) => d.exec(sql),
    transaction: (fn) => d.transaction(fn),
  };
}
