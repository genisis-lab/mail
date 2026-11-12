import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Button, Input, Spinner } from './ui';

/** An app (Wren for Mac) asking to unlock the admin panel, waiting for approval here. */
export interface UnlockRequest {
  id: string;
  accountId: number;
  account: string;
  device: string;
  ip: string | null;
  country: string | null;
  at: number;
  expiresAt: number;
  /** This browser signed in with two factors, so it can vouch for the second step. */
  canApprove: boolean;
}

/** Requests for every account signed in on this browser (the server answers only for those). */
export function useUnlockRequests(enabled = true) {
  return useQuery({
    queryKey: ['admin-unlocks'],
    queryFn: () => api.get<{ requests: UnlockRequest[] }>('/api/auth/admin-unlocks'),
    enabled,
    // Someone who just asked from the app switches here, so look again on focus too.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** For admins and helpdesk staff: a request from an app is waiting. */
export function AdminUnlockBar() {
  const requests = useUnlockRequests().data?.requests ?? [];
  if (!requests.length) return null;
  const r = requests[0];
  return (
    <div role="alert" className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-accent-soft px-3 py-2 text-[13px] max-md:mx-2">
      <KeyRound className="size-4 shrink-0 text-accent-ink" aria-hidden />
      <span className="min-w-0 flex-1">
        {r.device || 'An app'} is asking to unlock the admin panel for {r.account}.
      </span>
      <Link to="/approve" className="shrink-0 font-medium text-accent-ink hover:underline">
        Review
      </Link>
    </div>
  );
}

/** Approve or deny each waiting request by typing the number the app shows. */
export function UnlockApprovals() {
  const qc = useQueryClient();
  const q = useUnlockRequests();
  const [done, setDone] = useState<{ approved: boolean; account: string } | null>(null);
  const requests = q.data?.requests ?? [];

  if (q.isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (done) {
    return (
      <div role="status">
        <div className={`flex size-12 items-center justify-center rounded-2xl ${done.approved ? 'bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok' : 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger'}`}>
          {done.approved ? <ShieldCheck className="size-6" aria-hidden /> : <ShieldAlert className="size-6" aria-hidden />}
        </div>
        <h1 className="mt-4 text-xl font-semibold">{done.approved ? 'Approved' : 'Denied'}</h1>
        <p className="mt-2 text-sm text-muted">
          {done.approved ? (
            'Go back to the app: the admin panel opens there in a moment.'
          ) : (
            <>
              The app can’t open the admin panel. If you didn’t ask for this, someone knows the password for <b className="text-fg">{done.account}</b>: change it and revoke your app passwords in{' '}
              <Link to="/settings/security" className="font-medium text-accent-ink hover:underline">
                Settings → Security
              </Link>
              .
            </>
          )}
        </p>
        {requests.length > 0 && (
          <Button className="mt-5" onClick={() => setDone(null)}>
            Next request
          </Button>
        )}
      </div>
    );
  }
  if (!requests.length) {
    return (
      <div>
        <h1 className="text-xl font-semibold">Nothing to approve</h1>
        <p className="mt-2 text-sm text-muted">
          No app is waiting to unlock the admin panel. In Wren for Mac, choose Admin Panel, enter your account password, then choose Approve on the Web.
        </p>
        <Link to="/inbox" className="mt-6 inline-flex text-sm font-medium text-accent-ink hover:underline">
          Go to your inbox
        </Link>
      </div>
    );
  }
  return (
    <Request
      key={requests[0].id}
      request={requests[0]}
      onAnswered={(approved) => {
        setDone({ approved, account: requests[0].account });
        void qc.invalidateQueries({ queryKey: ['admin-unlocks'] });
      }}
    />
  );
}

function Request({ request: r, onAnswered }: { request: UnlockRequest; onAnswered: (approved: boolean) => void }) {
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const where = [r.ip, r.country].filter(Boolean).join(', ');

  const answer = async (value: number | null) => {
    setBusy(value === null ? 'deny' : 'approve');
    setError(null);
    try {
      const res = await api.post<{ approved: boolean }>(`/api/auth/admin-unlocks/${encodeURIComponent(r.id)}`, { number: value });
      onAnswered(res.approved);
    } catch (err) {
      // A wrong number denies the request; say so and show the outcome.
      if ((err as { status?: number }).status === 400) onAnswered(false);
      else setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{2}$/.test(number)) void answer(Number(number));
      }}
    >
      <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
        <KeyRound className="size-6" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold">Unlock the admin panel?</h1>
      <p className="mt-2 text-sm text-muted">
        <b className="text-fg">{r.device || 'An app'}</b> asked {relativeTime(r.at)} to unlock the admin panel for <b className="text-fg">{r.account}</b>, after the account password was entered{where ? ` from ${where}` : ''}.
      </p>
      {r.canApprove ? (
        <>
          <label htmlFor="unlock-number" className="mt-5 block text-sm font-medium">
            Enter the number the app shows
          </label>
          <Input
            id="unlock-number"
            className="mt-1.5 w-28 text-center text-lg tracking-[0.3em]"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            maxLength={2}
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 2))}
            aria-describedby="unlock-help"
          />
          <p id="unlock-help" className="mt-1.5 text-xs text-muted">
            A wrong number denies the request.
          </p>
        </>
      ) : (
        <p className="mt-4 rounded-xl bg-panel2 px-3 py-2 text-sm text-muted">
          This browser was signed in with only a password, so it can’t approve. Sign out, then sign in again with your 2-step code or a passkey.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        {r.canApprove && (
          <Button type="submit" variant="primary" loading={busy === 'approve'} disabled={!/^\d{2}$/.test(number) || busy !== null}>
            Approve
          </Button>
        )}
        <Button type="button" variant="ghost" className="text-danger" loading={busy === 'deny'} disabled={busy !== null} onClick={() => void answer(null)}>
          This wasn’t me
        </Button>
      </div>
    </form>
  );
}
