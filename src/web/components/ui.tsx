import { createPortal } from 'react-dom';
import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── Buttons ─────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 shadow-sm',
  secondary: 'bg-panel text-fg border border-line-strong hover:bg-hover',
  ghost: 'text-fg hover:bg-hover',
  danger: 'bg-danger text-white hover:brightness-110',
  soft: 'bg-accent-soft text-accent-ink hover:bg-accent-soft hover:brightness-95',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-[background,filter,color] select-none whitespace-nowrap disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' | 'lg'; active?: boolean }
>(function IconButton({ label, size = 'md', active, className, children, ...rest }, ref) {
  const dim = size === 'sm' ? 'size-8' : size === 'lg' ? 'size-12' : 'size-10';
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent',
        active && 'bg-hover text-fg',
        dim,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

// ── Form controls ───────────────────────────────────────────────────────────

const fieldBase =
  'w-full rounded-lg border border-line-strong bg-panel px-3 text-sm text-fg placeholder:text-faint transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(fieldBase, 'h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, 'min-h-24 py-2 leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('relative', className)}>
      <select className={cx(fieldBase, 'h-10 appearance-none pr-9')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function Field({ label, help, error, children, className }: { label?: ReactNode; help?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      {label && <span className="mb-1.5 block text-[13px] font-medium text-fg">{label}</span>}
      {children}
      {help && !error && <span className="mt-1.5 block text-xs leading-relaxed text-muted">{help}</span>}
      {error && <span className="mt-1.5 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** For a switch with no visible label. */
  ariaLabel?: string;
}) {
  return (
    <label className={cx('flex items-start gap-3', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium">{label}</span>}
          {description && <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Checkbox({ checked, indeterminate, onChange, label, className }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cx('group inline-flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-hover', className)}
    >
      <span
        className={cx(
          'flex size-[18px] items-center justify-center rounded-[4px] border-2 transition-colors',
          checked || indeterminate ? 'border-accent bg-accent text-accent-fg' : 'border-faint group-hover:border-muted',
        )}
      >
        {indeterminate ? <span className="h-0.5 w-2.5 rounded bg-current" /> : checked ? <Check className="size-3.5" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

// ── Misc ────────────────────────────────────────────────────────────────────

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} />;
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'; className?: string }) {
  const tones = {
    neutral: 'bg-panel2 text-muted',
    accent: 'bg-accent-soft text-accent-ink',
    ok: 'bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok',
    warn: 'bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-warn',
    danger: 'bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function Card({ children, className, title, actions, description }: { children: ReactNode; className?: string; title?: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-panel2 text-muted">{icon}</div>}
      <p className="text-[15px] font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex min-w-6 items-center justify-center rounded-md border border-line-strong bg-panel2 px-1.5 py-0.5 font-mono text-[11px] text-fg">{children}</kbd>;
}

// ── Modal ───────────────────────────────────────────────────────────────────

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Keep keyboard focus inside a dialog while it's open, move focus into it, and
 * give focus back to whatever had it when it closes.
 */
export function useDialogFocus(open: boolean, ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return; // an autoFocus field already has it
      const field = el.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]');
      (field ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      } else if (e.key === 'Tab') {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open, ref]);
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(open, ref, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-[1px] max-sm:px-3 max-sm:pt-[calc(env(safe-area-inset-top)+1rem)] max-sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className={cx('animate-pop w-full rounded-2xl bg-panel shadow-float outline-none', width)}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
      >
        {title && (
          <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-2 max-sm:px-4">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        <div className="px-6 py-3 max-sm:px-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 px-6 pt-2 pb-5 max-sm:px-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ── Menu (dropdown) ─────────────────────────────────────────────────────────

export interface MenuItem {
  label?: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  divider?: boolean;
  hint?: ReactNode;
}

export function Menu({
  trigger,
  items,
  align = 'left',
  width = 'w-56',
  children,
}: {
  trigger: (props: { onClick: (e: React.MouseEvent) => void; open: boolean }) => ReactNode;
  items?: MenuItem[];
  align?: 'left' | 'right';
  width?: string;
  children?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const viaKeyboard = useRef(false);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const pw = panel.current?.offsetWidth ?? 224;
    const ph = panel.current?.offsetHeight ?? 200;
    let left = align === 'right' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.bottom + 4;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    setPos({ top, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (panel.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        anchor.current?.querySelector<HTMLElement>('button')?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)') ?? [])];
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    };
    if (viaKeyboard.current) setTimeout(() => panel.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')?.focus(), 0);
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <>
      <span ref={anchor} className="inline-flex">
        {trigger({
          open,
          onClick: (e) => {
            e.stopPropagation();
            // A click with no pointer position came from the keyboard (Enter/Space).
            viaKeyboard.current = e.detail === 0;
            setOpen((o) => !o);
          },
        })}
      </span>
      {open &&
        createPortal(
          <div
            ref={panel}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            role={children ? undefined : 'menu'}
            className={cx('animate-pop fixed z-[70] max-h-[70vh] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-line bg-panel py-1.5 shadow-float', width)}
            onClick={(e) => e.stopPropagation()}
          >
            {children
              ? children(() => setOpen(false))
              : items?.map((it, i) =>
                  it.divider ? (
                    <div key={i} role="separator" className="my-1.5 border-t border-line" />
                  ) : (
                    <button
                      key={i}
                      role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                      aria-checked={it.checked}
                      disabled={it.disabled}
                      onClick={() => {
                        setOpen(false);
                        it.onClick?.();
                      }}
                      className={cx(
                        'flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-40',
                        it.danger ? 'text-danger' : 'text-fg',
                      )}
                    >
                      {it.checked !== undefined ? (
                        <span className="flex size-4 items-center justify-center">{it.checked && <Check className="size-4 text-accent-ink" />}</span>
                      ) : (
                        it.icon && <span className="flex size-4 items-center justify-center text-muted">{it.icon}</span>
                      )}
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.hint && <span className="text-xs text-faint">{it.hint}</span>}
                    </button>
                  ),
                )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.value ? 'border-accent text-accent-ink' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between text-[13px] text-muted">
        <span>{label}</span>
        {icon && <span className="text-faint">{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [ref, onOutside, active]);
}
