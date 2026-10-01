/**
 * Runtime configuration, populated from the Worker's env bindings by
 * src/worker/index.ts via initConfig().
 */

type Vars = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export const config = {
  /** Encryption/signing key: the WREN_SECRET binding, or one generated on first start. */
  secret: '',
  /** WREN_SECRET differs from the key the data was encrypted with. */
  keyMismatch: false,
  /** Public origin. Taken from each request unless PUBLIC_URL pins it. */
  publicUrl: 'http://localhost:8787',
  publicUrlPinned: false,
};

export type Config = typeof config;

export function initConfig(vars: Vars, opts: { secret: string }) {
  config.secret = opts.secret;
  const pinned = str(vars.PUBLIC_URL);
  config.publicUrlPinned = !!pinned;
  if (pinned) config.publicUrl = pinned.replace(/\/+$/, '');
  if (!config.secret || config.secret.length < 16) throw new Error('WREN_SECRET must be at least 16 characters');
}
