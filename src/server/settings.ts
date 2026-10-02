import { all, run } from './db/index.js';

/** Instance-wide settings editable from the admin panel. */
export const DEFAULT_SETTINGS = {
  'instance.name': 'Wren',
  'instance.accent': '#2563eb',
  'instance.loginMessage': '',
  'instance.setupComplete': false,

  'registration.mode': 'closed' as 'closed' | 'invite' | 'open',
  'registration.domains': [] as number[],

  'security.passwordMinLength': 10,
  'security.require2fa': 'none' as 'none' | 'admins' | 'all',
  'security.sessionDays': 30,
  'security.maxLoginAttempts': 10,

  'limits.defaultQuotaMb': 10240,
  'limits.maxAttachmentMb': 25,
  'limits.defaultSendPerDay': 500,
  'limits.maxRecipients': 100,

  'retention.trashDays': 30,
  'retention.spamDays': 30,

  'spam.enabled': true,
  'spam.threshold': 6,
  'spam.rspamdUrl': '',
  'spam.rspamdPassword': '',

  'mail.localDelivery': true,
  'mail.allowExternalForwarding': true,
  'mail.maxRetries': 6,
  'mail.inboundRejectUnknown': true,
  /** Sender of password links, invites and alerts. Empty: contact@ a hosted domain. */
  'mail.systemFrom': '',
  /** Display name for system mail. Empty: the instance name. */
  'mail.systemName': '',
  /** Where replies to system mail go. Empty: no Reply-To. */
  'mail.systemReplyTo': '',

  'users.welcomeMessage': true,
  'aliases.selfService': false,
  'aliases.maxPerUser': 5,
  /** Let people (not just admins) make throwaway sign-up aliases. */
  'aliases.throwaway': false,
  'aliases.maxThrowaway': 50,

  /** Daily backup of the database to blob storage (R2). */
  'backups.enabled': true,
  /** Automatic backups to keep. */
  'backups.keep': 7,
  /** Hour of the day (UTC) the automatic backup runs. */
  'backups.hour': 3,

  'alerts.email': true,
  'alerts.externalTo': '',
  'alerts.queueThreshold': 50,
  'alerts.quotaPercent': 90,

  'cloudflare.apiToken': '',
  'cloudflare.workerName': 'wren',
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      try {
        merged[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore corrupt values; fall back to default */
      }
    }
  }
  cache = merged as Settings;
  return cache;
}

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return getSettings()[key];
}

export function setSettings(values: Partial<Settings>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[key as SettingKey];
    if (typeof def !== typeof value && !(Array.isArray(def) && Array.isArray(value))) {
      throw new Error(`Invalid type for setting ${key}`);
    }
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      JSON.stringify(value),
    ]);
  }
  cache = null;
}

export function invalidateSettings() {
  cache = null;
}
