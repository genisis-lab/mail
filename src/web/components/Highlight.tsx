/** Text with the words a search looked for (searchTerms) marked. */
export function Highlight({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length || !text) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  // split() with a group puts the matches at the odd places.
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded-[3px] bg-accent-soft text-inherit">{part}</mark> : part))}</>;
}
