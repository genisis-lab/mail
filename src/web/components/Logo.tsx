import { Bird } from 'lucide-react';
import { cx } from './ui';

export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center justify-center rounded-[10px] bg-accent text-accent-fg shadow-sm', className ?? 'size-9')}>
      <Bird className="size-[60%]" strokeWidth={2.2} />
    </span>
  );
}

export function Logo({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="text-[20px] font-semibold tracking-tight">{name}</span>
    </span>
  );
}
