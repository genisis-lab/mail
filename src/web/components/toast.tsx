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
      <div className="pointer-events-none fixed bottom-6 left-6 z-[80] flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`animate-slide-up pointer-events-auto flex min-w-72 max-w-[480px] items-center gap-4 rounded-lg px-4 py-3 text-sm shadow-float ${
              t.tone === 'error' ? 'bg-[#b3261e] text-white' : 'bg-[#2b2f36] text-white dark:bg-[#e6e8ec] dark:text-[#1d2129]'
            }`}
          >
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                className="font-semibold text-[#8ab4f8] hover:underline dark:text-[#1a56db]"
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
                className="font-semibold text-[#8ab4f8] hover:underline dark:text-[#1a56db]"
                onClick={() => {
                  t.secondary!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.secondary.label}
              </button>
            )}
            <button aria-label="Dismiss" className="opacity-70 hover:opacity-100" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
