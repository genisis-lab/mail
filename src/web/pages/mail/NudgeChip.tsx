import { relativeTime } from '../../lib/format';

/** "No reply yet": back in the inbox because nobody answered in time. */
export function NudgeChip({ sentAt }: { sentAt: number }) {
  return (
    <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] px-1.5 text-[11px] leading-[18px] font-medium text-warn" title="You asked to be reminded if nobody replied">
      No reply · sent {relativeTime(sentAt)}
    </span>
  );
}
