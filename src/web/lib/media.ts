import { useEffect, useState } from 'react';

/** Track a CSS media query, e.g. `useMediaQuery('(max-width: 639px)')`. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const PHONE = '(max-width: 639px)';

// Phones in portrait or touch devices with a short landscape viewport.
export const PHONE_COMPOSE = PHONE + ', (pointer: coarse) and (max-height: 540px)';
