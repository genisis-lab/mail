import { colorFor, initials } from '../lib/format';
import { cx } from './ui';

export function Avatar({ name, address, size = 40, className }: { name?: string; address: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none', className)}
      style={{ width: size, height: size, background: colorFor(address || name || '?'), fontSize: Math.round(size * 0.4) }}
    >
      {initials(name || address)}
    </span>
  );
}
