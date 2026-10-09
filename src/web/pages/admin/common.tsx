import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cx } from '../../components/ui';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {/* Can shrink to the page width, so on a phone the buttons wrap instead of running off the edge. */}
      {actions && <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A data table. On phones each row becomes a card, with the column name in
 * front of each value (taken from `head`), so nothing needs sideways scrolling.
 */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLTableElement>(null);
  const labels = head.map((h) => (typeof h === 'string' ? h : ''));
  useLayoutEffect(() => {
    ref.current?.querySelectorAll(':scope > tbody > tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if ((td as HTMLTableCellElement).colSpan > 1) return;
        const label = labels[i] ?? '';
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
      });
    });
  });
  return (
    <div className={cx('overflow-x-auto rounded-2xl border border-line bg-panel', className)}>
      <table ref={ref} className="wren-table w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 font-medium whitespace-nowrap first:pl-5 last:pr-5">
                {h === '' ? <span className="sr-only">Actions</span> : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line [&>tr:last-child]:border-0 [&_td]:px-4 [&_td]:py-3 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'muted' }) {
  const c = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', muted: 'bg-faint' }[tone];
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', c)} />;
}

/** A value to copy into a DNS host or another dashboard. Placeholders like "(from Resend)" aren't copyable. */
export function CopyField({ value, onCopy, label }: { value: string; onCopy: () => void; label?: string }) {
  const placeholder = /^\(.*\)$/.test(value.trim());
  return (
    <div className={cx('flex min-w-0 items-center gap-2 rounded-lg border border-line py-1 pr-1 pl-3', placeholder ? 'border-dashed bg-transparent' : 'bg-panel2')}>
      <code className={cx('min-w-0 flex-1 truncate py-1 font-mono text-[12.5px]', placeholder && 'font-sans text-muted italic')} title={value}>
        {value}
      </code>
      {!placeholder && (
        <button
          type="button"
          aria-label={label ? `Copy ${label}` : 'Copy'}
          className="rounded-md px-2 py-1 text-xs font-medium text-accent-ink hover:bg-hover"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            onCopy();
          }}
        >
          Copy
        </button>
      )}
    </div>
  );
}
