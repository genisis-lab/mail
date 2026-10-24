import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export interface ToastOptions {
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  duration?: number;
  tone?: 'default' | 'error';
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastCtx = createContext<(t: ToastOptions | string) => () => void>(() => () => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (t: ToastOptions | string) => {
      const opts: ToastOptions = typeof t === 'string' ? { message: t } : t;
      const id = ++seq.current;
      // Only one toast at a time, like Gmail.
      setItems([{ ...opts, id }]);
      const timer = setTimeout(() => dismiss(id), opts.duration ?? (opts.action ? 7000 : 4000));
      return () => {
        clearTimeout(timer);
        dismiss(id);
      };
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {/* Always present, so screen readers announce what appears in it. */}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed right-[calc(env(safe-area-inset-right)+0.75rem)] bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] left-[calc(env(safe-area-inset-left)+0.75rem)] z-[80] flex flex-col gap-2 sm:right-auto sm:bottom-6 sm:left-6">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`animate-slide-up pointer-events-auto flex max-w-[480px] items-center gap-1 rounded-lg py-2 pr-2 pl-4 text-sm shadow-float sm:min-w-72 ${
              t.tone === 'error' ? 'bg-[#b3261e] text-white' : 'bg-[#2b2f36] text-white dark:bg-[#e6e8ec] dark:text-[#1d2129]'
            }`}
          >
            <span className="flex-1 py-1 pr-1 sm:pr-2">{t.message}</span>
            {t.action && (
              <button
                className="min-h-9 shrink-0 rounded-md px-2 font-semibold sm:px-2.5 whitespace-nowrap text-[#8ab4f8] hover:bg-white/10 dark:text-[#1a56db] dark:hover:bg-black/5"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.secondary && (
              <button
                className="min-h-9 shrink-0 rounded-md px-2 font-semibold sm:px-2.5 whitespace-nowrap text-[#8ab4f8] hover:bg-white/10 dark:text-[#1a56db] dark:hover:bg-black/5"
                onClick={() => {
                  t.secondary!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.secondary.label}
              </button>
            )}
            <button aria-label="Dismiss" className="grid size-9 shrink-0 place-items-center rounded-md opacity-70 hover:bg-white/10 hover:opacity-100 dark:hover:bg-black/5" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
