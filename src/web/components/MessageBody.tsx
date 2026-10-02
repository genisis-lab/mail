import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff, MoreHorizontal } from 'lucide-react';
import type { AttachmentInfo } from '../../shared/types';
import { renderMailHtml, textToSafeHtml } from '../lib/sanitize';
import { cx } from './ui';

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
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>
  html,body{margin:0;padding:0;}
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;
    ${isHtml ? 'color:#222;background:#fff;' : dark ? 'color:#e6e8ec;background:transparent;' : 'color:#1d2129;background:transparent;'}}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  pre{white-space:pre-wrap;}
  a{color:${isHtml ? '#1a56db' : dark ? '#8ab4f8' : '#1a56db'};}
  blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;}
  .wren-hidden-quote{display:none !important;}
  ${dark && !isHtml ? 'blockquote{border-color:#444;color:#a1a7b3}' : ''}
</style></head><body>${rendered.html}</body></html>`;

  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    let ro: ResizeObserver | null = null;
    const onLoad = () => {
      const doc = f.contentDocument;
      if (!doc) return;
      const quotes = QUOTE_SELECTORS.flatMap((s) => [...doc.querySelectorAll(s)]).filter((el) => !el.parentElement?.closest(QUOTE_SELECTORS.join(',')));
      setHasQuote(quotes.length > 0);
      quotes.forEach((q) => q.classList.toggle('wren-hidden-quote', !showQuote));
      const measure = () => setHeight(Math.max(40, doc.documentElement.scrollHeight));
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(doc.body);
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    };
    f.addEventListener('load', onLoad);
    if (f.contentDocument?.readyState === 'complete') onLoad();
    return () => {
      f.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [srcDoc, showQuote]);

  return (
    <div>
      <div className={cx(isHtml && 'overflow-hidden rounded-lg', isHtml && dark && 'bg-white p-3')}>
        <iframe
          ref={frame}
          title="Message body"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          style={{ height }}
          className="block w-full border-0"
        />
      </div>
      {hasQuote && (
        <button
          onClick={() => setShowQuote((s) => !s)}
          title={showQuote ? 'Hide trimmed content' : 'Show trimmed content'}
          className="mt-2 inline-flex h-4 items-center rounded-full bg-panel3 px-1.5 text-muted hover:bg-line-strong"
        >
          <MoreHorizontal className="size-4" />
        </button>
      )}
    </div>
  );
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
