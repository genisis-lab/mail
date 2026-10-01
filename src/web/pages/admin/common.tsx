import type { ReactNode } from 'react';
import { cx } from '../../components/ui';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto rounded-2xl border border-line bg-panel', className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 font-medium whitespace-nowrap first:pl-5 last:pr-5">
                {h}
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

export function CopyField({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-panel2 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-hover"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          onCopy();
        }}
      >
        Copy
      </button>
    </div>
  );
}
