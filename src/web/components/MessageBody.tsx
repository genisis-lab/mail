import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff, Moon, MoreHorizontal, Sun } from 'lucide-react';
import type { AttachmentInfo } from '../../shared/types';
import { adaptForDark, looksDesigned } from '../lib/dark-mail';
import { renderMailHtml, textToSafeHtml } from '../lib/sanitize';
import { cx } from './ui';

/** Body colours on the dark background (match the app's dark theme). */
const DARK = { text: '#e6e8ec', muted: '#a1a7b3', link: '#8ab4f8' };

const QUOTE_SELECTORS = ['.gmail_quote', 'blockquote[type="cite"]', '.wren-quote', '#divRplyFwdMsg', '.yahoo_quoted', '#appendonsend', '.moz-cite-prefix'];

/**
 * Renders an email body inside a sandboxed iframe (no scripts) that sizes
 * itself to its content. Quoted history is collapsed behind a "…" toggle.
 */
export function MessageBody({
  html,
  text,
  attachments,
  allowRemote,
  onBlockedImages,
}: {
  html: string | null;
  text: string | null;
  attachments: AttachmentInfo[];
  allowRemote: boolean;
  onBlockedImages?: (n: number) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const [hasQuote, setHasQuote] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const isHtml = !!html;

  const rendered = useMemo(() => {
    if (html) return renderMailHtml(html, { attachments, allowRemote });
    return { html: textToSafeHtml(text ?? ''), blockedImages: 0 };
  }, [html, text, attachments, allowRemote]);

  useEffect(() => onBlockedImages?.(rendered.blockedImages), [rendered.blockedImages, onBlockedImages]);

  const dark = document.documentElement.classList.contains('dark');
  // In dark mode: designed mail keeps white paper, ordinary mail goes dark. The reader can flip it.
  const designed = useMemo(() => isHtml && looksDesigned(rendered.html), [isHtml, rendered.html]);
  const [paperChoice, setPaperChoice] = useState<boolean | null>(null);
  const paper = isHtml && (!dark || (paperChoice ?? designed));
  const darkText = dark && !paper;
  // The email sits in <wren-fit><wren-mail>: its own CSS can't target those
  // tags, and they are what gets measured and, when too wide, scaled to fit.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>
  html,body{margin:0;padding:0;}
  /* Without this the browser paints an opaque white backdrop behind the frame in dark mode. */
  :root{color-scheme:${darkText ? 'dark' : 'light'};-webkit-text-size-adjust:100%;text-size-adjust:100%;}
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;
    ${paper ? 'color:#222;background:#fff;' : darkText ? `color:${DARK.text};background:transparent;` : 'color:#1d2129;background:transparent;'}}
  /* The frame grows to fit the email, so the email's own full-height or scrolling page setup must not apply. */
  html,body{height:auto !important;min-height:0 !important;max-height:none !important;}
  html{overflow-x:hidden !important;overflow-y:auto !important;}
  body{overflow:visible !important;}
  wren-fit{display:block;overflow-x:auto;overflow-y:hidden;}
  wren-mail{display:flow-root;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  pre{white-space:pre-wrap;}
  a{color:${darkText ? DARK.link : '#1a56db'};}
  blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;}
  .wren-hidden-quote{display:none !important;}
  ${darkText ? `blockquote{border-color:#444;color:${DARK.muted}}` : ''}
</style></head><body><wren-fit><wren-mail>${rendered.html}</wren-mail></wren-fit></body></html>`;

  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    const cleanups: (() => void)[] = [];
    const onLoad = () => {
      const doc = f.contentDocument;
      const win = f.contentWindow;
      const fit = doc?.querySelector<HTMLElement>('wren-fit');
      const mail = doc?.querySelector<HTMLElement>('wren-mail');
      // Before the email loads the frame holds a blank page: nothing to measure yet.
      if (!doc || !win || !fit || !mail) return;
      cleanups.splice(0).forEach((c) => c());
      const quotes = QUOTE_SELECTORS.flatMap((s) => [...doc.querySelectorAll(s)]).filter((el) => !el.parentElement?.closest(QUOTE_SELECTORS.join(',')));
      setHasQuote(quotes.length > 0);
      if (darkText && isHtml) adaptForDark(doc, DARK);
      quotes.forEach((q) => q.classList.toggle('wren-hidden-quote', !showQuote));

      let last = 0;
      let step = 0;
      let repeats = 0;
      const measure = () => {
        // Lay the email out at the frame's width, then see whether it fits.
        mail.style.width = '';
        mail.style.transform = '';
        fit.style.height = '';
        fit.style.overflowX = '';
        const room = doc.documentElement.clientWidth;
        const wide = naturalWidth(mail);
        let scale = 1;
        // A fixed-width layout (a 600–700px newsletter on a phone) is shrunk to fit, like Gmail does.
        if (room > 0 && wide > room + 1) {
          mail.style.width = `${wide}px`;
          // Overflow that grows with the width (width:100% plus padding) isn't cured by
          // shrinking; that's left to scroll sideways instead.
          if (naturalWidth(mail) <= wide + 1) {
            scale = room / wide;
            mail.style.transformOrigin = '0 0';
            mail.style.transform = `scale(${scale})`;
          } else mail.style.width = '';
        }
        if (scale < 1) {
          // Shrunk to fit: nothing is left to the side (the unshrunk box would still scroll).
          fit.style.overflowX = 'hidden';
          fit.style.height = `${Math.ceil(mail.getBoundingClientRect().height)}px`;
        }
        const h = Math.ceil(fit.getBoundingClientRect().height);
        if (h <= 0 || h === last) return;
        // Content sized by the frame itself (100vh) grows the frame by the same step every
        // round, forever. Images and fonts loading grow it by varying amounts.
        const grew = h - last;
        repeats = last > 0 && grew > 0 && Math.abs(grew - step) <= 2 ? repeats + 1 : 0;
        step = grew;
        if (repeats >= 3) return;
        last = h;
        setHeight(h);
      };
      measure();
      // The frame's own ResizeObserver: Safari doesn't report elements of another document to the page's.
      const RO = (win as typeof window).ResizeObserver ?? ResizeObserver;
      const ro = new RO(() => measure());
      ro.observe(mail);
      win.addEventListener('resize', measure);
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
      void doc.fonts?.ready.then(measure);
      // A last look once late layout (fonts, slow images) has settled.
      const timers = [150, 600, 2000].map((ms) => win.setTimeout(measure, ms));
      cleanups.push(() => {
        ro.disconnect();
        win.removeEventListener('resize', measure);
        timers.forEach((t) => win.clearTimeout(t));
      });
    };
    f.addEventListener('load', onLoad);
    if (f.contentDocument?.readyState === 'complete') onLoad();
    return () => {
      f.removeEventListener('load', onLoad);
      cleanups.splice(0).forEach((c) => c());
    };
  }, [srcDoc, showQuote, darkText, isHtml]);

  return (
    <div>
      <div className={cx(isHtml && 'overflow-hidden rounded-lg', paper && dark && 'bg-white p-3')}>
        <iframe
          ref={frame}
          title="Message body"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          style={{ height }}
          className="block w-full border-0"
        />
      </div>
      {(hasQuote || (dark && isHtml)) && (
        <div className="mt-2 flex items-center gap-2">
          {hasQuote && (
            <button
              onClick={() => setShowQuote((s) => !s)}
              title={showQuote ? 'Hide trimmed content' : 'Show trimmed content'}
              aria-label={showQuote ? 'Hide trimmed content' : 'Show trimmed content'}
              className="inline-flex h-4 items-center rounded-full bg-panel3 px-1.5 text-muted hover:bg-line-strong"
            >
              <MoreHorizontal className="size-4" />
            </button>
          )}
          {dark && isHtml && (
            <button
              onClick={() => setPaperChoice(!paper)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted hover:bg-panel3 hover:text-fg"
              title={paper ? 'Show this message with a dark background' : 'Show this message’s original colours'}
            >
              {paper ? <Moon className="size-3.5" aria-hidden /> : <Sun className="size-3.5" aria-hidden />}
              {paper ? 'Dark background' : 'Original colours'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How wide the email really is. scrollWidth misses some overflow (a table cell
 * made display:block with width:100% plus padding, say), so the right-most
 * element edge counts too.
 */
function naturalWidth(mail: HTMLElement): number {
  const left = mail.getBoundingClientRect().left;
  let right = mail.scrollWidth;
  const all = mail.getElementsByTagName('*');
  for (let i = 0; i < all.length && i < 4000; i++) {
    const r = all[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0) right = Math.max(right, r.right - left);
  }
  return Math.ceil(right);
}

export function BlockedImagesBanner({ count, onShow, onAlways }: { count: number; onShow: () => void; onAlways: () => void }) {
  if (!count) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-panel2 px-3 py-2 text-[13px]">
      <ImageOff className="size-4 text-muted" />
      <span className="text-muted">Images are hidden to protect your privacy.</span>
      <button onClick={onShow} className="font-medium text-accent-ink hover:underline">
        Display images
      </button>
      <button onClick={onAlways} className="font-medium text-accent-ink hover:underline">
        Always display images
      </button>
    </div>
  );
}
