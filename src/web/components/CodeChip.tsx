/** One tap to copy a sign-in code found in a message ("980708"). */
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useToast } from './toast';
import { cx } from './ui';

export function CodeChip({ code, size = 'sm', className }: { code: string; size?: 'sm' | 'md'; className?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy code ${code}`}
      title="Copy code"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
          toast('Code copied');
        } catch {
          toast({ message: 'Couldn’t copy. Press and hold the code to copy it.', tone: 'error' });
        }
      }}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent-soft font-mono font-semibold tracking-wide text-accent-ink hover:brightness-95',
        size === 'sm' ? 'h-6 px-2 text-[12px]' : 'h-8 px-3 text-sm',
        className,
      )}
    >
      {copied ? <Check className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden /> : <Copy className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />}
      <span className="select-all">{code}</span>
    </button>
  );
}
