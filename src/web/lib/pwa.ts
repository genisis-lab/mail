/** Installable app and Web Push: service worker registration, install prompt, push subscription. */
import { useEffect, useState } from 'react';
import { api } from './api';

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

export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await api.post('/api/me/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
