/** "via hello@" on a conversation: which of your addresses it was sent to. Opens everything sent there. */
import { AtSign } from 'lucide-react';
import { useNavigate } from 'react-router';
import { cx } from '../../components/ui';

export function ViaChip({ address, className }: { address: string; className?: string }) {
  const navigate = useNavigate();
  const local = address.split('@')[0];
  return (
    <button
      type="button"
      title={`Sent to ${address}. Show all mail sent to this address.`}
      aria-label={`Sent to ${address}. Show all mail sent there`}
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/search/${encodeURIComponent(`deliveredto:${address}`)}`);
      }}
      className={cx(
        'inline-flex max-w-32 shrink-0 items-center gap-0.5 rounded border border-line px-1 text-[11px] leading-[16px] text-muted hover:border-line-strong hover:text-fg',
        className,
      )}
    >
      <AtSign className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{local}</span>
    </button>
  );
}
