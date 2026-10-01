import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Link2,
  RemoveFormatting,
  Undo2,
  Redo2,
  Code,
  Heading2,
} from 'lucide-react';
import { cx } from './ui';

export interface RichEditorHandle {
  focus: () => void;
  getHtml: () => string;
  setHtml: (html: string) => void;
  insertHtml: (html: string) => void;
}

function exec(cmd: string, value?: string) {
  document.execCommand(cmd, false, value);
}

export const RichEditor = forwardRef<
  RichEditorHandle,
  {
    initialHtml: string;
    onChange: (html: string) => void;
    placeholder?: string;
    showToolbar?: boolean;
    onPasteFiles?: (files: File[]) => void;
    className?: string;
    autoFocus?: boolean;
  }
>(function RichEditor({ initialHtml, onChange, placeholder, showToolbar = true, onPasteFiles, className, autoFocus }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (el.current) el.current.innerHTML = initialHtml;
    if (autoFocus) {
      el.current?.focus();
      // Place the caret at the very start (above any quote/signature).
      const sel = window.getSelection();
      if (sel && el.current) {
        const r = document.createRange();
        r.setStart(el.current, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => el.current?.focus(),
    getHtml: () => el.current?.innerHTML ?? '',
    setHtml: (html: string) => {
      if (el.current) el.current.innerHTML = html;
    },
    insertHtml: (html: string) => {
      el.current?.focus();
      exec('insertHTML', html);
      onChange(el.current?.innerHTML ?? '');
    },
  }));

  const emit = () => onChange(el.current?.innerHTML ?? '');

  const tool = (label: string, icon: React.ReactNode, action: () => void, active?: boolean) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => {
        e.preventDefault();
        action();
        emit();
        force((n) => n + 1);
      }}
      className={cx('flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg', active && 'bg-hover text-fg')}
    >
      {icon}
    </button>
  );

  const state = (cmd: string) => {
    try {
      return document.queryCommandState(cmd);
    } catch {
      return false;
    }
  };

  return (
    <div className={cx('flex min-h-0 flex-col', className)}>
      <div
        ref={el}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label="Message body"
        data-placeholder={placeholder}
        className="wren-editor min-h-40 flex-1 overflow-y-auto px-1 py-2 text-[14px]"
        onInput={emit}
        onKeyUp={() => force((n) => n + 1)}
        onMouseUp={() => force((n) => n + 1)}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            const url = window.prompt('Link URL', 'https://');
            if (url) exec('createLink', url);
            emit();
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length && onPasteFiles) {
            e.preventDefault();
            onPasteFiles(files);
            return;
          }
          const html = e.clipboardData.getData('text/html');
          if (html) {
            e.preventDefault();
            const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script', 'meta', 'link', 'form', 'input'], FORBID_ATTR: ['class', 'id'] });
            exec('insertHTML', clean as string);
            emit();
          }
        }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files];
          if (files.length && onPasteFiles) {
            e.preventDefault();
            onPasteFiles(files);
          }
        }}
      />
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-0.5 border-t border-line pt-1.5">
          {tool('Undo', <Undo2 className="size-4" />, () => exec('undo'))}
          {tool('Redo', <Redo2 className="size-4" />, () => exec('redo'))}
          <span className="mx-1 h-5 w-px bg-line" />
          {tool('Heading', <Heading2 className="size-4" />, () => exec('formatBlock', state('h2') ? 'p' : 'h2'))}
          {tool('Bold (⌘B)', <Bold className="size-4" />, () => exec('bold'), state('bold'))}
          {tool('Italic (⌘I)', <Italic className="size-4" />, () => exec('italic'), state('italic'))}
          {tool('Underline (⌘U)', <Underline className="size-4" />, () => exec('underline'), state('underline'))}
          {tool('Strikethrough', <Strikethrough className="size-4" />, () => exec('strikeThrough'), state('strikeThrough'))}
          <span className="mx-1 h-5 w-px bg-line" />
          {tool('Bulleted list', <List className="size-4" />, () => exec('insertUnorderedList'), state('insertUnorderedList'))}
          {tool('Numbered list', <ListOrdered className="size-4" />, () => exec('insertOrderedList'), state('insertOrderedList'))}
          {tool('Quote', <Quote className="size-4" />, () => exec('formatBlock', 'blockquote'))}
          {tool('Code', <Code className="size-4" />, () => exec('formatBlock', 'pre'))}
          {tool('Link (⌘K)', <Link2 className="size-4" />, () => {
            const url = window.prompt('Link URL', 'https://');
            if (url) exec('createLink', url);
          })}
          {tool('Remove formatting', <RemoveFormatting className="size-4" />, () => exec('removeFormat'))}
        </div>
      )}
    </div>
  );
});
