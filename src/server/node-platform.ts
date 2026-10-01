import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Resolver } from 'node:dns/promises';
import { getConnInfo } from '@hono/node-server/conninfo';
import type Database from 'better-sqlite3';
import { config } from './config.js';
import type { BlobStore, DnsResolver, Platform } from './platform.js';

/** Content-addressed files: blobs/ab/cd/abcdef… */
export function fsBlobStore(root: string): BlobStore {
  const file = (key: string) => path.join(root, key.slice(0, 2), key.slice(2, 4), key);
  return {
    async put(key, data) {
      const f = file(key);
      if (fs.existsSync(f)) return;
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, f);
    },
    async get(key) {
      try {
        return new Uint8Array(await fs.promises.readFile(file(key)));
      } catch {
        return null;
      }
    },
    async delete(key) {
      await fs.promises.rm(file(key), { force: true });
    },
    async *list() {
      if (!fs.existsSync(root)) return;
      for (const a of await fs.promises.readdir(root)) {
        const da = path.join(root, a);
        if (!(await fs.promises.stat(da)).isDirectory()) continue;
        for (const b of await fs.promises.readdir(da)) {
          const db = path.join(da, b);
          for (const key of await fs.promises.readdir(db)) {
            if (key.endsWith('.tmp')) continue;
            const st = await fs.promises.stat(path.join(db, key));
            yield { key, size: st.size, uploaded: st.mtimeMs };
          }
        }
      }
    },
  };
}

export function nodeDnsResolver(): DnsResolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  const servers = process.env.DNS_SERVERS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (servers?.length) r.setServers(servers);
  const empty = (err: any) => {
    if (err?.code === 'ENODATA' || err?.code === 'ENOTFOUND') return [];
    throw err;
  };
  return {
    txt: (name) => r.resolveTxt(name).then((rows) => rows.map((parts) => parts.join('')), empty),
    mx: (name) => r.resolveMx(name).catch(empty),
    cname: (name) => r.resolveCname(name).catch(empty),
  };
}

export function nodePlatform(db: Database.Database | null): Platform {
  return {
    name: 'node',
    blobs: fsBlobStore(config.blobDir),
    dns: nodeDnsResolver(),
    env: process.env as Record<string, unknown>,
    clientIp(c) {
      try {
        return getConnInfo(c).remote.address ?? '';
      } catch {
        return '';
      }
    },
    databaseSize() {
      return ['', '-wal', '-shm'].reduce((n, s) => {
        try {
          return n + fs.statSync(config.dbPath + s).size;
        } catch {
          return n;
        }
      }, 0);
    },
    systemInfo() {
      return {
        node: process.version,
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        memory: process.memoryUsage().rss,
        dataDir: config.dataDir,
        secretFromEnv: !!process.env.WREN_SECRET,
      };
    },
    async backup() {
      if (!db) throw new Error('No database');
      const tmp = path.join(os.tmpdir(), `wren-backup-${Date.now()}.db`);
      await db.backup(tmp);
      const data = new Uint8Array(fs.readFileSync(tmp));
      fs.unlinkSync(tmp);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      return { data, filename: `wren-${stamp}.db`, contentType: 'application/vnd.sqlite3' };
    },
  };
}
