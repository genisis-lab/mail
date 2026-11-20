import { expect, test } from '@playwright/test';

test('scheduled garbage collection records blob storage usage in Durable Object SQLite', async ({ request }) => {
  const endpoint = '/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/wren-WrenDurableObject/query';
  async function query(sql: string) {
    const response = await request.post(endpoint, {
      data: { durable_object_name: 'wren', queries: [{ sql }] },
    });
    await expect(response).toBeOK();
    const data = await response.json();
    expect(data.success).toBe(true);
    return data.result[0].rows;
  }

  // An alarm can run at startup. Make GC due and require a new measurement.
  await query("DELETE FROM _meta WHERE key IN ('last_gc', 'blob_bytes')");
  await expect(await request.get('/cdn-cgi/local/scheduled')).toBeOK();
  await expect.poll(() => query("SELECT value FROM _meta WHERE key = 'blob_bytes'"))
    .toEqual([[expect.stringMatching(/^\d+$/)]]);
});
