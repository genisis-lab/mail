import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKey, readPrivateKey, decryptKey } from 'openpgp';
import { backupKey, restoreKey, storedKey, storeKey, lockKeys, unlockedKey, unlockKey, forgetKey } from '../src/web/lib/pgp';
import { harness } from './harness';

afterEach(() => { lockKeys(); vi.unstubAllGlobals(); });

describe('PGP backup in browsers without local storage', () => {
  it('restores encrypted keys, unlocks locally, and never uploads a passphrase or clear key', async () => {
    const h = harness();
    await h.setup();
    await h.login('admin@wren.test', 'a very long password');
    const id = (await h.call('GET', '/api/auth/me')).body.user.id;
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, body: String(init.body ?? '') });
      return h.request(url, init);
    });
    const passphrase = 'a separate PGP passphrase';
    const pair = await generateKey({ userIDs: [{ email: 'admin@wren.test' }], passphrase, format: 'armored' });
    storeKey(id, pair.privateKey);
    expect(storedKey(id)).toBe(pair.privateKey);
    await backupKey(id, pair.privateKey);
    const clear = await decryptKey({ privateKey: await readPrivateKey({ armoredKey: pair.privateKey }), passphrase });
    const count = requests.length;
    await expect(backupKey(id, clear.armor())).rejects.toThrow(/passphrase/);
    expect(requests).toHaveLength(count);
    lockKeys(); // closing a private window drops all browser-side state
    expect(storedKey(id)).toBeNull();
    expect(await restoreKey(id)).toContain('PRIVATE KEY BLOCK');
    expect(unlockedKey(id)).toBeNull();
    await expect(unlockKey(id, 'wrong')).rejects.toThrow(/passphrase/);
    expect((await unlockKey(id, passphrase)).getFingerprint()).toBe(clear.getFingerprint());
    lockKeys();
    expect(unlockedKey(id)).toBeNull();
    expect(JSON.stringify(requests)).not.toContain(passphrase);
    expect(requests.filter((r) => r.body)).toHaveLength(1);
    // A local key is never replaced by a server backup without the user's choice.
    const another = await generateKey({ userIDs: [{ email: 'admin@wren.test' }], passphrase, format: 'armored' });
    storeKey(id, another.privateKey);
    expect(await restoreKey(id)).toBe(another.privateKey);
    forgetKey(id);
    expect(storedKey(id)).toBeNull();
  });
});
