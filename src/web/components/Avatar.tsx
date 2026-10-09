import { useState, useSyncExternalStore } from 'react';
import { colorFor, initials } from '../lib/format';
import { cx } from './ui';

/**
 * Addresses known to have no picture this session, so lists don't ask again
 * on every render; and a version per address, bumped when you change your own.
 */
const missing = new Set<string>();
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
let revision = 0;
/** Bumped when the sender-pictures setting changes, so every picture is asked for again. */
let generation = 0;

export function resetAvatars() {
  missing.clear();
  generation = Date.now();
  revision++;
  listeners.forEach((l) => l());
}

/** After a profile picture changes: show the new one (or initials) everywhere. */
export function refreshAvatar(addresses: string[], version = Date.now()) {
  for (const a of addresses) {
    const key = a.toLowerCase();
    if (versions.get(key) === version) continue;
    missing.delete(key);
    versions.set(key, version);
  }
  revision++;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * A person's picture: their profile picture on this server, a Gravatar, or
 * their company's verified logo (the server finds these); initials until one
 * loads, or when there's none. `picture={false}` shows initials only (mail
 * that failed the sender checks shouldn't wear someone's face or logo).
 */
export function Avatar({ name, address, size = 40, className, picture = true }: { name?: string; address: string; size?: number; className?: string; picture?: boolean }) {
  useSyncExternalStore(subscribe, () => revision);
  const key = (address || '').toLowerCase();
  const [loaded, setLoaded] = useState<string | null>(null);
  const version = versions.get(key);
  const query = [version ? `v=${version}` : '', generation ? `g=${generation}` : ''].filter(Boolean).join('&');
  const src = picture && key.includes('@') && !missing.has(key) ? `/api/avatars/${encodeURIComponent(key)}${query ? `?${query}` : ''}` : null;
  return (
    <span
      aria-hidden
      className={cx('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white select-none', className)}
      style={{ width: size, height: size, background: colorFor(address || name || '?'), fontSize: Math.round(size * 0.4) }}
    >
      {initials(name || address)}
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(src)}
          onError={() => {
            missing.add(key);
            setLoaded(null);
          }}
          className={cx('absolute inset-0 size-full bg-white object-cover transition-opacity duration-200', loaded === src ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </span>
  );
}
