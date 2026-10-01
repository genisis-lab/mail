import { insert, now, run, tx } from '../db/index.js';
import { encryptJson, randomToken } from '../lib/crypto.js';
import { badRequest } from '../lib/http.js';
import { getProviderDef } from '../providers/registry.js';

/** Placeholder the admin UI shows instead of stored secrets. */
export const MASK = '••••••••';

/** Normalise a provider config against its field definitions. */
export function cleanConfig(type: string, input: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  const def = getProviderDef(type);
  if (!def) throw badRequest('Unknown provider type');
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    let v = input[f.key];
    if (v === MASK) v = previous[f.key];
    if (v === undefined || v === null || v === '') v = f.default ?? (f.type === 'boolean' ? false : '');
    if (f.type === 'number' && v !== '') v = Number(v);
    if (f.type === 'boolean') v = v === true || v === 'true';
    if (typeof v === 'string') v = v.trim();
    if (f.required && (v === '' || v === undefined)) throw badRequest(`${f.label} is required`);
    if (f.type === 'select' && f.options && v !== '' && !f.options.some((o) => o.value === v)) throw badRequest(`Invalid value for ${f.label}`);
    out[f.key] = v;
  }
  return out;
}

export function createProvider(input: { name: string; type: string; config: Record<string, unknown>; enabled?: boolean; isDefault?: boolean }): number {
  const cfg = cleanConfig(input.type, input.config);
  return tx(() => {
    if (input.isDefault) run('UPDATE providers SET is_default = 0');
    return insert('INSERT INTO providers (name, type, config, enabled, is_default, inbound_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      input.name,
      input.type,
      encryptJson(cfg),
      input.enabled === false ? 0 : 1,
      input.isDefault ? 1 : 0,
      randomToken(24),
      now(),
    ]);
  });
}
