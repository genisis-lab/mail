/** Installable app and Web Push: service worker registration, install prompt, push subscription. */
import { useEffect, useState } from 'react';
import { api, apiFor } from './api';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** The browser's "Install app" prompt, when it offers one. */
export function useInstallPrompt(): { available: boolean; install: () => Promise<boolean> } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return {
    available: !!deferred,
    install: async () => {
      if (!deferred) return false;
      await deferred.prompt();
      const choice = await deferred.userChoice;
      deferred = null;
      listeners.forEach((l) => l());
      return choice.outcome === 'accepted';
    },
  };
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** This browser's push address, if it has one (signing out tells the server to stop using it). */
export async function pushEndpoint(): Promise<string | null> {
  try {
    return (await currentPushSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether this device gets an account's notifications. The browser has one
 * subscription for all its accounts, and each account turns it on or off.
 */
export async function pushStatus(account?: number): Promise<{ subscribed: boolean; others: number }> {
  const sub = await currentPushSubscription().catch(() => null);
  if (!sub) return { subscribed: false, others: 0 };
  return apiFor(null, account).post<{ subscribed: boolean; others: number }>('/api/me/push/status', { endpoint: sub.endpoint });
}

/** Ask for permission and register this device for new-mail pushes. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('This browser can’t receive notifications');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser’s site settings.');
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>('/api/me/push');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different server key can't be reused.
  if (sub && sub.options.applicationServerKey) {
    const key = new Uint8Array(sub.options.applicationServerKey);
    const want = fromB64url(publicKey);
    if (key.length !== want.length || key.some((b, i) => b !== want[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) });
  const json = sub.toJSON();
  await api.post('/api/me/push/subscribe', { endpoint: json.endpoint!, keys: json.keys as { p256dh: string; auth: string } });
}

/** This account stops getting notifications here; the browser keeps its subscription while another account uses it. */
export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  const r = await api.post<{ shared: number }>('/api/me/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => ({ shared: 0 }));
  if (!r.shared) await sub.unsubscribe();
}

/**
 * Signed in to another account on a device that already gets notifications for
 * an account here: it gets the new account's too (each can turn them off in Settings).
 */
export async function pushHere(account: number): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await currentPushSubscription();
    if (!sub) return;
    const status = await pushStatus(account);
    if (status.subscribed || !status.others) return;
    const json = sub.toJSON();
    await apiFor(null, account).post('/api/me/push/subscribe', { endpoint: json.endpoint!, keys: json.keys as { p256dh: string; auth: string } });
  } catch {
    /* they can turn it on in Settings */
  }
}
