/**
 * Full-screen preview of a message's attachments: images, PDFs, text,
 * audio and video, with previous / next, download and open in a new tab.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileQuestion, X } from 'lucide-react';
import type { AttachmentInfo } from '../../shared/types';
import { fileSize } from '../lib/format';
import { cx, Spinner, useDialogFocus } from './ui';

type Kind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'none';

const TEXT_EXT = /\.(txt|log|csv|tsv|md|markdown|json|xml|ya?ml|ini|conf|cfg|ics|vcf|eml|diff|patch|sh|py|js|ts|css|sql)$/i;
const TEXT_LIMIT = 512 * 1024;

export function previewKind(a: Pick<AttachmentInfo, 'contentType' | 'filename' | 'size'>): Kind {
  const t = a.contentType.toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|bmp|avif)/.test(t)) return 'image';
  if (t.startsWith('application/pdf')) return 'pdf';
  if (/^audio\/(mpeg|mp3|ogg|wav|webm|aac|mp4|x-m4a)/.test(t)) return 'audio';
  if (/^video\/(mp4|webm|ogg|quicktime)/.test(t)) return 'video';
  if (a.size <= TEXT_LIMIT && ((t.startsWith('text/') && !t.startsWith('text/html')) || /^application\/(json|xml)/.test(t) || TEXT_EXT.test(a.filename))) return 'text';
  return 'none';
}

const url = (a: AttachmentInfo, inline = false) => `/api/attachments/${a.id}${inline ? '?inline=1' : ''}`;

export function AttachmentViewer({ items, index, onIndex, onClose }: { items: AttachmentInfo[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = index !== null && !!items[index];
  useDialogFocus(open, ref, onClose);
  const a = open ? items[index!] : null;
  const kind = a ? previewKind(a) : 'none';
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && index! > 0) onIndex(index! - 1);
      if (e.key === 'ArrowRight' && index! < items.length - 1) onIndex(index! + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index, items.length, onIndex]);

  useEffect(() => {
    setText(null);
    setTextError(false);
    if (!a || kind !== 'text') return;
    let cancelled = false;
    fetch(url(a), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => !cancelled && setText(t))
      .catch(() => !cancelled && setTextError(true));
    return () => {
      cancelled = true;
    };
  }, [a?.id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !a) return null;
  const nav = (dir: -1 | 1) => {
    const next = index! + dir;
    if (next >= 0 && next < items.length) onIndex(next);
  };
  const button = 'flex size-10 shrink-0 items-center justify-center rounded-full text-white/90 hover:bg-white/15 focus-visible:bg-white/15';

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${a.filename}`}
      className="fixed inset-0 z-[70] flex flex-col bg-[rgba(12,12,14,0.96)] text-white backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <button type="button" className={button} onClick={onClose} aria-label="Close preview">
          <X className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{a.filename}</p>
          <p className="text-xs text-white/70">
            {fileSize(a.size)}
            {items.length > 1 ? ` · ${index! + 1} of ${items.length}` : ''}
          </p>
        </div>
        {(kind === 'image' || kind === 'pdf') && (
          <a className={button} href={url(a, true)} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
            <ExternalLink className="size-5" />
          </a>
        )}
        <a className={button} href={url(a)} aria-label={`Download ${a.filename}`} title="Download">
          <Download className="size-5" />
        </a>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-16" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {kind === 'image' && <img key={a.id} src={url(a, true)} alt={a.filename} className="max-h-full max-w-full rounded object-contain shadow-2xl" />}
        {kind === 'pdf' && <iframe key={a.id} src={url(a, true)} title={a.filename} className="h-full w-full max-w-5xl rounded bg-white" />}
        {kind === 'audio' && <audio key={a.id} src={url(a, true)} controls className="w-full max-w-lg" />}
        {kind === 'video' && <video key={a.id} src={url(a, true)} controls className="max-h-full max-w-full rounded" />}
        {kind === 'text' &&
          (text !== null ? (
            <pre className="h-full w-full max-w-4xl overflow-auto rounded-lg bg-[#1e1e1e] p-4 text-[13px] leading-relaxed whitespace-pre-wrap text-[#e6e6e6]" tabIndex={0} aria-label={`Contents of ${a.filename}`}>
              {text}
            </pre>
          ) : textError ? (
            <NoPreview a={a} />
          ) : (
            <Spinner />
          ))}
        {kind === 'none' && <NoPreview a={a} />}
        {index! > 0 && (
          <button type="button" className={cx(button, 'absolute top-1/2 left-2 -translate-y-1/2 bg-black/40 max-sm:top-auto max-sm:bottom-4')} onClick={() => nav(-1)} aria-label="Previous attachment">
            <ChevronLeft className="size-6" />
          </button>
        )}
        {index! < items.length - 1 && (
          <button type="button" className={cx(button, 'absolute top-1/2 right-2 -translate-y-1/2 bg-black/40 max-sm:top-auto max-sm:bottom-4')} onClick={() => nav(1)} aria-label="Next attachment">
            <ChevronRight className="size-6" />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

function NoPreview({ a }: { a: AttachmentInfo }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-white/10 px-8 py-10 text-center">
      <FileQuestion className="size-10 text-white/80" aria-hidden />
      <p className="text-sm">No preview for this kind of file.</p>
      <a href={url(a)} className="inline-flex h-9 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-black hover:bg-white/90">
        <Download className="size-4" /> Download
      </a>
    </div>
  );
}
