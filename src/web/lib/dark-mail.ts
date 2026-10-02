/**
 * Dark mode for email bodies. Ordinary messages (replies, notes, most personal
 * mail) take the app's dark colours. Designed ones (newsletters, receipts:
 * their own backgrounds or layout) keep a white "paper" background, since
 * inverting them breaks logos and brand colours, like Gmail and Apple Mail do.
 */

const PLAIN_BACKGROUND = /^(#fff(fff)?|white|transparent|none|inherit|initial|unset|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*[\d.]+\s*)?\))\s*(!important)?\s*$/i;

/** True for mail that sets its own look: coloured or image backgrounds, or a fixed-width layout. */
export function looksDesigned(html: string): boolean {
  for (const m of html.matchAll(/(?:\bbgcolor\s*=\s*["']?|background(?:-color)?\s*:\s*)([^;"'>]+)/gi)) {
    if (!PLAIN_BACKGROUND.test(m[1].trim())) return true;
  }
  if (/background-image\s*:|background\s*:[^;"']*url\(/i.test(html)) return true;
  // Newsletter layouts: fixed-width tables or containers.
  if (/<table[^>]*\bwidth\s*=\s*["']?\d{3}/i.test(html) || /\b(?:max-)?width\s*:\s*[4-9]\d\dpx/i.test(html)) return true;
  return false;
}

const rgb = (v: string): [number, number, number, number] | null => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
};

/** Relative luminance (0 = black, 1 = white). */
export function luminance([r, g, b]: [number, number, number, number] | [number, number, number]): number {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/**
 * After an ordinary message renders on the dark background: text colours
 * meant for white paper (near-black, dark grey, dark link blue) become light,
 * and white highlight boxes from pasted text go away. Colours that already
 * read well on dark (a red warning, say) are left alone.
 */
export function adaptForDark(doc: Document, colors: { text: string; link: string }) {
  for (const el of doc.body.querySelectorAll<HTMLElement>('*')) {
    const cs = doc.defaultView!.getComputedStyle(el);
    const fg = rgb(cs.color);
    if (fg && luminance(fg) < 0.18) el.style.setProperty('color', el.closest('a') ? colors.link : colors.text, 'important');
    const bg = rgb(cs.backgroundColor);
    if (bg && bg[3] > 0 && luminance(bg) > 0.7) el.style.setProperty('background-color', 'transparent', 'important');
  }
}
