/** Remembers the last thread list so the conversation view can offer newer/older navigation. */
let last: { base: string; ids: number[]; search: string } = { base: '/inbox', ids: [], search: '' };

export function setListContext(base: string, ids: number[], search = '') {
  last = { base, ids, search };
}

export function getListContext() {
  return last;
}

/** "/inbox", "/label/3", "/search/foo" for a pathname that may end in a thread id. */
export function listBase(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'label' || parts[0] === 'search') return `/${parts[0]}/${parts[1] ?? ''}`;
  return `/${parts[0] ?? 'inbox'}`;
}
