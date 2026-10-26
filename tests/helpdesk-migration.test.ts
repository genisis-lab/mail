import { describe, expect, it } from 'vitest';
import { all, get, openDb, run, splitStatements } from '../src/server/db/index';
import { migrations } from '../src/server/db/migrations';
import { nodeSqlDriver } from './sqlite';

/** The migration that adds users.helpdesk (found by content: its number may change). */
const HELPDESK = migrations.findIndex((m) => /ADD COLUMN helpdesk\b/.test(m));

describe('the helpdesk migration', () => {
  it('keeps every row, index, trigger and cascade of a database made before it', () => {
    expect(HELPDESK).toBeGreaterThan(0);
    // A database as it was just before the migration, holding a little of everything that points at users.
    const d = nodeSqlDriver(':memory:');
    d.exec('CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (let v = 0; v < HELPDESK; v++) d.transaction(() => splitStatements(migrations[v]).forEach((s) => d.exec(s)));
    d.run(`INSERT INTO _meta (key, value) VALUES ('schema_version', ?)`, [String(HELPDESK)]);
    const ts = 1_700_000_000_000;
    d.exec(`
      INSERT INTO users (id, email, name, password_hash, role, kind, created_at) VALUES
        (1, 'owner@wren.test', 'Owner', 'h', 'owner', 'person', ${ts}),
        (2, 'admin@wren.test', 'Admin', 'h', 'admin', 'person', ${ts}),
        (3, 'sam@wren.test', 'Sam', 'h', 'user', 'person', ${ts}),
        (4, 'team@wren.test', 'Team', 'h', 'user', 'shared', ${ts});
      INSERT INTO domains (id, name, verify_token, catch_all_user_id, created_at) VALUES (1, 'wren.test', 't', 3, ${ts});
      INSERT INTO addresses (id, address, domain_id, kind, user_id, created_at) VALUES (1, 'sam@wren.test', 1, 'mailbox', 3, ${ts});
      INSERT INTO threads (id, user_id, subject, last_date, created_at) VALUES (1, 3, 'Hi', ${ts}, ${ts});
      INSERT INTO messages (id, user_id, thread_id, folder, subject, date, created_at) VALUES (1, 3, 1, 'inbox', 'Hi', ${ts}, ${ts});
      INSERT INTO labels (id, user_id, name, created_at) VALUES (1, 3, 'Work', ${ts});
      INSERT INTO message_labels (message_id, label_id) VALUES (1, 1);
      INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES ('s', 3, ${ts}, ${ts}, ${ts * 2});
      INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, created_at) VALUES (3, 'c', 'k', -7, ${ts});
      INSERT INTO mailbox_members (mailbox_id, user_id, created_at) VALUES (4, 3, ${ts});
      INSERT INTO invites (token_hash, role, created_by, expires_at, created_at) VALUES ('x', 'admin', 2, ${ts}, ${ts});
      INSERT INTO audit_log (user_id, action, created_at) VALUES (3, 'auth.login', ${ts});
    `);
    const tables = () => (d.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'messages_fts%' AND name != '_meta' ORDER BY name`, []) as { name: string }[]).map((t) => t.name);
    const counts = () => Object.fromEntries(tables().map((t) => [t, (d.all(`SELECT COUNT(*) AS c FROM "${t}"`, [])[0] as { c: number }).c]));
    const schema = () => d.all(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') OR (type = 'table' AND name != 'users') ORDER BY type, name`, []);
    // Its own statement text: the test driver caches statements, and a cached SELECT * keeps the columns it first saw.
    const usersBefore = d.all('SELECT * FROM users ORDER BY id -- before', []);
    const countsBefore = counts();
    const schemaBefore = schema();
    expect(countsBefore.jmap_changes).toBeGreaterThan(0);

    openDb(d);

    expect(get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'schema_version'`)!.value).toBe(String(migrations.length));
    expect(all('SELECT * FROM users ORDER BY id')).toEqual(usersBefore.map((u) => ({ ...(u as object), helpdesk: 0 })));
    // Later migrations may add tables; every table that existed before must keep its rows.
    const countsAfter = counts();
    expect(Object.fromEntries(Object.keys(countsBefore).map((table) => [table, countsAfter[table]]))).toEqual(countsBefore);
    // Only users changed (when this is the latest migration, nothing else in the schema did).
    if (HELPDESK === migrations.length - 1) expect(schema()).toEqual(schemaBefore);
    expect(all('PRAGMA foreign_key_check')).toEqual([]);
    expect(all<{ table: string }>('PRAGMA foreign_key_list(sessions)').map((f) => f.table)).toEqual(['users']);

    // Helpdesk staff: ordinary people only.
    run('UPDATE users SET helpdesk = 1 WHERE id = 3');
    for (const id of [1, 2, 4]) expect(() => run('UPDATE users SET helpdesk = 1 WHERE id = ?', [id])).toThrow(/CHECK/);
    expect(() => run(`UPDATE users SET role = 'admin' WHERE id = 3`)).toThrow(/CHECK/);

    // Deleting someone still takes their rows with them, and the JMAP trigger still clears their change log.
    run('DELETE FROM users WHERE id = 3');
    for (const t of ['addresses', 'threads', 'messages', 'labels', 'message_labels', 'sessions', 'passkeys', 'mailbox_members', 'jmap_changes', 'jmap_modseq']) {
      expect(get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)!.c, t).toBe(0);
    }
    expect(get('SELECT user_id FROM audit_log')).toEqual({ user_id: null });
    expect(get('SELECT catch_all_user_id FROM domains')).toEqual({ catch_all_user_id: null });
    expect(get<{ c: number }>('SELECT COUNT(*) AS c FROM users')!.c).toBe(3);
  });
});
