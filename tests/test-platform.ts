import type { BlobStore, Platform } from '../src/server/platform';
import { nodeTcp } from './node-tcp';

/** In-memory blob store standing in for R2. */
export function memoryBlobStore(): BlobStore {
  const files = new Map<string, { data: Uint8Array; uploaded: number }>();
  return {
    async put(key, data) {
      if (!files.has(key)) files.set(key, { data: new Uint8Array(data), uploaded: Date.now() });
    },
    async get(key) {
      return files.get(key)?.data ?? null;
    },
    async delete(keys) {
      for (const k of keys) files.delete(k);
    },
    async *list() {
      for (const [key, v] of files) yield { key, size: v.data.length, uploaded: v.uploaded };
    },
  };
}

/** The Worker's platform services, simulated in-process for tests. */
export function testPlatform(): Platform {
  return {
    blobs: memoryBlobStore(),
    dns: { txt: async () => [], mx: async () => [], cname: async () => [] },
    tcp: nodeTcp,
    env: {},
    databaseSize: () => 0,
    systemInfo: () => ({ platform: 'test' }),
  };
}
