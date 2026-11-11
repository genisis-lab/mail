import { Link } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { Inbox, Paperclip } from 'lucide-react';
import type { ThreadSummary } from '../../../shared/types';
import { accountHref, useAccounts, type BrowserAccount } from '../../lib/accounts';
import { apiFor } from '../../lib/api';
import { shortDate } from '../../lib/format';
import { useSession } from '../../lib/session';
import { cx, Empty, Spinner } from '../../components/ui';

/**
 * Every account signed in on this browser: their inboxes in one list, newest
 * first. A conversation opens in its own account (another account's opens at
 * its address, so this tab stays the account it is).
 */
export function AllInboxes() {
  const { user } = useSession();
  const accounts = useAccounts().data?.accounts ?? [];
  const lists = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ['all-inboxes', a.id],
      queryFn: () => apiFor(null, a.id).get<{ threads: ThreadSummary[] }>('/api/mail/threads?view=inbox&pageSize=50'),
      refetchInterval: 30_000,
    })),
  });
  const rows = lists
    .flatMap((q, i) => (q.data?.threads ?? []).map((t) => ({ t, account: accounts[i] })))
    .sort((a, b) => b.t.date - a.t.date)
    .slice(0, 100);
  const loading = lists.some((q) => q.isLoading);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-line px-4">
        <h1 className="text-[15px] font-medium">All Inboxes</h1>
        {loading && <Spinner className="ml-3 size-4" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loading && !rows.length ? (
          <Empty icon={<Inbox className="size-7" />} title="Every inbox is empty" />
        ) : (
          <div role="list" aria-label="All Inboxes">
            {rows.map(({ t, account }) => (
              <Row key={`${account.id}:${t.id}`} t={t} account={account} here={account.id === user.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ t, account, here }: { t: ThreadSummary; account: BrowserAccount; here: boolean }) {
  const from = t.participants.filter((p) => !p.me).map((p) => p.name || p.address);
  const className = cx(
    'flex h-11 items-center gap-3 border-b border-line px-4 text-sm transition-colors hover:bg-hover',
    t.unread ? 'bg-unread-row font-bold' : 'bg-read-row',
  );
  const content = (
    <>
      <span className="w-44 shrink-0 truncate max-md:w-28">{from.slice(-2).join(', ') || '(unknown)'}</span>
      <span className="max-w-40 shrink-0 truncate rounded bg-panel3 px-1.5 text-[11px] leading-[18px] font-normal text-muted max-sm:hidden">{account.email}</span>
      <span className="min-w-0 flex-1 truncate">
        {t.subject || '(no subject)'}
        {t.snippet && <span className="font-normal text-muted"> – {t.snippet}</span>}
      </span>
      {t.hasAttachments && <Paperclip className="size-4 shrink-0 text-muted" aria-label="Has attachments" />}
      <span className={cx('w-16 shrink-0 text-right text-xs', t.unread ? 'text-fg' : 'font-normal text-muted')}>{shortDate(t.date)}</span>
    </>
  );
  // This tab's own account opens in place; another account opens at its own address.
  return here ? (
    <Link role="listitem" to={`/inbox/${t.id}`} className={className}>
      {content}
    </Link>
  ) : (
    <a role="listitem" href={accountHref(account, `/inbox/${t.id}`)} className={className}>
      {content}
    </a>
  );
}
