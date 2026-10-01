import { useEffect, useRef } from 'react';

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Gmail-style single-key shortcuts. The handler receives `e.key`
 * (e.g. "j", "#", "I", "Enter") and returns true when it handled the key.
 */
export function useHotkeys(handler: (key: string, e: KeyboardEvent) => boolean | void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (ref.current(e.key, e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
