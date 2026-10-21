import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronRight, Globe, KeyRound, Mail, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { APP_NAME, APP_TAGLINE } from '../../shared/brand';
import type { SessionUser } from '../../shared/types';
import { landingPath, openAccount, openSignedIn, signOut, useAccounts } from '../lib/accounts';
import { api, getApiAccount } from '../lib/api';
import { passkeysSupported, signInWithPasskey } from '../lib/passkeys';
import { lastAccount, useMe, type Instance } from '../lib/session';
import { Avatar } from '../components/Avatar';
import { Logo } from '../components/Logo';
import { TwoFactorSetup } from '../components/TwoFactorSetup';
import { Button, Field, Input, Select, Spinner } from '../components/ui';

function AuthShell({ instance, children, wide }: { instance: Instance; children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-bg px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-[420px]'}`}>
        <div className="mb-8 flex justify-center">
          <Logo name={instance.name || APP_NAME} />
        </div>
        <div className="animate-pop rounded-3xl border border-line bg-panel p-8 shadow-panel max-sm:p-6">{children}</div>
        <p className="mt-6 text-center text-xs text-faint">
          {APP_NAME} {instance.version} · {APP_TAGLINE}
        </p>
      </div>
    </main>
  );
}

/** Where "sign in" is from here: the sign-in page, or adding another account when one is signed in. */
function useSignInPath() {
  return useMe().data?.user ? '/add-account' : '/login';
}

/**
 * Sign in. `add`: another account next to the one signed in (from the account
 * menu). `again`: this tab's account isn't signed in on this browser any more,
 * but others are, and it offers them too.
 */
export function LoginPage({ instance, mfaPending, next, mode = 'signin' }: { instance: Instance; mfaPending: boolean; next: string; mode?: 'signin' | 'add' | 'again' }) {
  const qc = useQueryClient();
  const last = mode === 'again' ? lastAccount() : null;
  const [step, setStep] = useState<'password' | 'mfa'>(mfaPending && mode !== 'add' ? 'mfa' : 'password');
  const [email, setEmail] = useState(last?.email ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const done = async (user?: SessionUser) => {
    // A tab that belongs to an account opens the one just signed in at its own address.
    if (user && (await openSignedIn(user.id, next))) return;
    await qc.invalidateQueries({ queryKey: ['me'] });
    navigate(landingPath(next), { replace: true });
  };

  return (
    <AuthShell instance={instance}>
      {step === 'password' ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await api.post<{ mfaRequired?: boolean; user?: SessionUser }>('/api/auth/login', { email, password });
              if (r.mfaRequired) setStep('mfa');
              else await done(r.user);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-4"
        >
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{mode === 'add' ? 'Add another account' : last ? 'Sign in again' : 'Sign in'}</h1>
            <p className="mt-1 text-sm text-muted">
              {mode === 'add'
                ? `Sign in to another ${instance.name} account. You can switch between them from your picture.`
                : mode === 'again'
                  ? last
                    ? `You’re signed out of ${last.email} on this device.`
                    : 'That account isn’t signed in on this device.'
                  : `to continue to ${instance.name}`}
            </p>
          </div>
          {params.has('deleted') && (
            <div role="status" className="rounded-xl bg-panel2 px-4 py-3 text-sm text-fg">
              Your account was deleted.
            </div>
          )}
          {instance.loginMessage && <div className="rounded-xl bg-accent-softer px-4 py-3 text-sm text-fg">{instance.loginMessage}</div>}
          <Field label="Email address">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!last} required />
          </Field>
          <Field label="Password" error={error}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!last} required />
          </Field>
          <div className="-mt-2 text-right">
            <Link to={`/forgot${email ? `?email=${encodeURIComponent(email)}` : ''}`} className="text-sm font-medium text-accent-ink hover:underline">
              Forgot password?
            </Link>
          </div>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Sign in
          </Button>
          {passkeysSupported() && (
            <Button
              type="button"
              className="w-full"
              icon={<KeyRound className="size-4" />}
              loading={passkeyBusy}
              onClick={async () => {
                setPasskeyBusy(true);
                setError(null);
                try {
                  const r = await signInWithPasskey(email.trim() || undefined);
                  if (r.mfaRequired) setStep('mfa');
                  else await done(r.user);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setPasskeyBusy(false);
                }
              }}
            >
              Sign in with a passkey
            </Button>
          )}
          {instance.registration !== 'closed' && (
            <p className="text-center text-sm text-muted">
              {mode === 'signin' ? 'New here?' : 'No account yet?'}{' '}
              <Link to="/register" className="font-medium text-accent-ink hover:underline">
                Create an account
              </Link>
            </p>
          )}
          {mode === 'add' && (
            <p className="text-center text-sm">
              <Link to="/inbox" className="font-medium text-muted hover:text-fg">
                Cancel
              </Link>
            </p>
          )}
          {mode === 'again' && <SignedInHere />}
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await api.post<{ user: SessionUser }>('/api/auth/mfa', { code });
              await done(r.user);
            } catch (err) {
              setError((err as Error).message);
              if ((err as any).status === 401 && /expired/i.test((err as Error).message)) setStep('password');
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-4"
        >
          <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
            <ShieldCheck className="size-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">2-step verification</h1>
            <p className="mt-1 text-sm text-muted">Enter the code from your authenticator app, or one of your recovery codes.</p>
          </div>
          <Field label="Code" error={error}>
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="123456" />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Verify
          </Button>
          <button
            type="button"
            className="w-full text-center text-sm text-muted hover:text-fg"
            onClick={async () => {
              // Gives up only this sign-in: accounts already signed in here stay.
              await api.post('/api/auth/cancel').catch(() => {});
              setStep('password');
            }}
          >
            Use a different account
          </button>
        </form>
      )}
    </AuthShell>
  );
}

/** The accounts still signed in on this browser, to carry on with one of them instead. */
function SignedInHere() {
  const qc = useQueryClient();
  // The list may be from before this tab's account was signed out.
  useEffect(() => void qc.invalidateQueries({ queryKey: ['accounts'] }), [qc]);
  const accounts = (useAccounts().data?.accounts ?? []).filter((a) => a.id !== getApiAccount());
  if (!accounts.length) return null;
  return (
    <div className="border-t border-line pt-4">
      <p className="mb-2 text-sm text-muted">Or continue with an account signed in on this device</p>
      <ul className="space-y-1">
        {accounts.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => openAccount(a)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-hover">
              <Avatar name={a.name} address={a.email} size={32} picture={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.name || a.email}</span>
                <span className="block truncate text-xs text-muted">{a.email}</span>
              </span>
              <ChevronRight className="size-4 text-muted" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RegisterPage({ instance, adding = false }: { instance: Instance; adding?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const inviteToken = params.get('invite');
  const [invite, setInvite] = useState<{ valid: boolean; email?: string; domain?: string } | null>(null);
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState(instance.registrationDomains[0] ?? '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inviteToken) return;
    api.get(`/api/auth/invite/${encodeURIComponent(inviteToken)}`).then((r) => {
      setInvite(r);
      if (r.email) {
        const [lp, d] = r.email.split('@');
        setLocalPart(lp);
        setDomain(d);
      } else if (r.domain) setDomain(r.domain);
    });
  }, [inviteToken]);

  const closed = !inviteToken && instance.registration !== 'open';
  const signInPath = adding ? '/add-account' : '/login';
  if (closed || (invite && !invite.valid)) {
    return (
      <AuthShell instance={instance}>
        <h1 className="text-xl font-semibold">{invite && !invite.valid ? 'Invitation expired' : 'Registration is invite-only'}</h1>
        <p className="mt-2 text-sm text-muted">Ask an administrator of {instance.name} for an invitation link.</p>
        <Link to={signInPath} className="mt-6 inline-flex text-sm font-medium text-accent-ink hover:underline">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  const domains = invite?.domain ? [invite.domain] : instance.registrationDomains;
  const lockedDomain = !!invite?.domain || !!invite?.email;

  return (
    <AuthShell instance={instance}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<{ user: SessionUser }>('/api/auth/register', { localPart, domain, name, password, invite: inviteToken ?? undefined });
            // Signed in next to another account: open the new one.
            if (await openSignedIn(r.user.id)) return;
            await qc.invalidateQueries({ queryKey: ['me'] });
            navigate('/inbox', { replace: true });
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{adding ? 'Create another account' : 'Create your account'}</h1>
          <p className="mt-1 text-sm text-muted">{adding ? `Get another mailbox on ${instance.name}, next to the one you’re signed in to` : `Get a mailbox on ${instance.name}`}</p>
        </div>
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required autoComplete="name" />
        </Field>
        <Field label="Email address">
          <div className="flex items-center gap-2">
            <Input value={localPart} onChange={(e) => setLocalPart(e.target.value.toLowerCase())} disabled={!!invite?.email} required placeholder="you" />
            <span className="text-muted">@</span>
            {lockedDomain || domains.length <= 1 ? (
              <span className="h-10 shrink-0 rounded-lg bg-panel2 px-3 text-sm leading-10">{domain || domains[0]}</span>
            ) : (
              <Select value={domain} onChange={(e) => setDomain(e.target.value)} className="w-48 shrink-0">
                {domains.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </Select>
            )}
          </div>
        </Field>
        <Field label="Password" error={error} help="Use a long passphrase you don’t use anywhere else.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create account
        </Button>
        <p className="text-center text-sm text-muted">
          Already have an account?{' '}
          <Link to={signInPath} className="font-medium text-accent-ink hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

/** One-time link from a password reset or an admin-created account: choose a password. */
export function ResetPage({ instance }: { instance: Instance }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signInPath = useSignInPath();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<{ valid: boolean; kind?: 'reset' | 'setup'; email?: string; name?: string } | null>(token ? null : { valid: false });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .get(`/api/auth/reset/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  if (!info) {
    return (
      <AuthShell instance={instance}>
        <div className="flex justify-center py-6">
          <Spinner className="size-6" />
        </div>
      </AuthShell>
    );
  }

  if (needsSignIn) {
    return (
      <AuthShell instance={instance}>
        <h1 className="text-xl font-semibold">Password updated</h1>
        <p className="mt-2 text-sm text-muted">Sign in with your new password to continue.</p>
        <Link to={signInPath} className="mt-6 inline-flex text-sm font-medium text-accent-ink hover:underline">
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  if (!info.valid) {
    return (
      <AuthShell instance={instance}>
        <h1 className="text-xl font-semibold">This link has expired</h1>
        <p className="mt-2 text-sm text-muted">The link is invalid or was already used. Ask an administrator of {instance.name} for a new one.</p>
        <Link to={signInPath} className="mt-6 inline-flex text-sm font-medium text-accent-ink hover:underline">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  const isSetup = info.kind === 'setup';
  return (
    <AuthShell instance={instance}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== confirm) {
            setError('The two passwords don’t match');
            return;
          }
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<{ signedIn: boolean; user?: SessionUser }>('/api/auth/reset', { token, password });
            if (r.signedIn && r.user && (await openSignedIn(r.user.id))) return;
            if (r.signedIn) {
              await qc.invalidateQueries({ queryKey: ['me'] });
              navigate('/inbox', { replace: true });
            } else setNeedsSignIn(true);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{isSetup ? 'Choose your password' : 'Reset your password'}</h1>
          <p className="mt-1 text-sm text-muted">
            for {info.email}
            {isSetup ? ` on ${instance.name}` : ''}
          </p>
        </div>
        <Field label="New password" help="Use a long passphrase you don’t use anywhere else.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required autoComplete="new-password" />
        </Field>
        <Field label="Confirm password" error={error}>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {isSetup ? 'Set password and sign in' : 'Update password'}
        </Button>
      </form>
    </AuthShell>
  );
}

export function SetupPage({ instance }: { instance: Instance }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [instanceName, setInstanceName] = useState('');
  const [domain, setDomain] = useState('');
  const [localPart, setLocalPart] = useState('admin');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setupInfo = useQuery({ queryKey: ['setup'], queryFn: () => api.get<{ needed: boolean; cloudflareEmail: boolean }>('/api/setup') });
  const cloudflareEmail = !!setupInfo.data?.cloudflareEmail;
  const [provider, setProvider] = useState<'cloudflare' | 'resend' | 'later' | null>(null);
  const [resendKey, setResendKey] = useState('');
  const chosen = provider ?? (cloudflareEmail ? 'cloudflare' : 'resend');

  const steps = [
    { icon: <Sparkles className="size-4" />, label: 'Welcome' },
    { icon: <Globe className="size-4" />, label: 'Domain' },
    { icon: <Send className="size-4" />, label: 'Email' },
    { icon: <KeyRound className="size-4" />, label: 'Admin account' },
  ];

  return (
    <AuthShell instance={{ ...instance, name: instanceName || instance.name }} wide>
      <div className="mb-6 flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.label} className="flex flex-1 items-center gap-2">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs ${
                i <= step ? 'bg-accent text-accent-fg' : 'bg-panel2 text-muted'
              }`}
            >
              {s.icon}
            </span>
            <span className={`truncate text-[13px] ${i === step ? 'font-medium' : 'text-muted'}`}>{s.label}</span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-line" />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to {APP_NAME}</h1>
          <p className="text-sm leading-relaxed text-muted">
            Let’s set up your mail. You’ll add your first domain, pick how mail is sent (Cloudflare Email Service needs no API key) and create the owner
            account.
          </p>
          <Field label="Name this instance" help="Shown on the sign-in page and in the browser tab.">
            <Input value={instanceName} onChange={(e) => setInstanceName(e.target.value)} placeholder="Fernhill Mail" autoFocus />
          </Field>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setStep(1)} disabled={!instanceName.trim()}>
              Continue <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">Your first domain</h1>
          <p className="text-sm text-muted">The domain your addresses will live on. You can add more later.</p>
          <Field label="Domain">
            <div className="relative">
              <Mail className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
              <Input className="pl-9" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder="example.com" autoFocus />
            </div>
          </Field>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => setStep(2)} disabled={!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)}>
              Continue <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">Sending and receiving</h1>
          <p className="text-sm text-muted">Choose how {domain} sends mail. You can add more providers, or switch, in the admin panel.</p>
          <div className="space-y-2" role="radiogroup" aria-label="Email provider">
            <ProviderChoice
              selected={chosen === 'cloudflare'}
              disabled={!cloudflareEmail}
              onSelect={() => setProvider('cloudflare')}
              title="Cloudflare Email Service"
              badge={cloudflareEmail ? 'Recommended' : 'Only on Cloudflare'}
              description={
                cloudflareEmail
                  ? 'Built into Workers, so there’s no API key. Email Routing delivers incoming mail straight to this Worker.'
                  : 'Available when Wren is deployed to Cloudflare Workers.'
              }
            />
            <ProviderChoice
              selected={chosen === 'resend'}
              onSelect={() => setProvider('resend')}
              title="Resend"
              description="Send with the Resend API. Receive with Cloudflare Email Routing, or with Resend’s inbound webhook."
            >
              {chosen === 'resend' && (
                <Input className="mt-3" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder="Resend API key (re_…)" autoComplete="off" />
              )}
            </ProviderChoice>
            <ProviderChoice
              selected={chosen === 'later'}
              onSelect={() => setProvider('later')}
              title="Choose later"
              description="Pick from 20+ providers (Amazon SES, Postmark, SendGrid, Mailgun, SMTP relays…) in Admin → Providers."
            />
          </div>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => setStep(3)} disabled={chosen === 'resend' && !resendKey.trim()}>
              Continue <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.post('/api/setup', { instanceName, domain, localPart, name, password, email: { provider: chosen, apiKey: chosen === 'resend' ? resendKey : undefined } });
              await qc.invalidateQueries({ queryKey: ['me'] });
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h1 className="text-2xl font-semibold tracking-tight">Owner account</h1>
          <p className="text-sm text-muted">This account can manage everything. It’s also a real mailbox.</p>
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Email address">
            <div className="flex items-center gap-2">
              <Input value={localPart} onChange={(e) => setLocalPart(e.target.value.toLowerCase())} required />
              <span className="shrink-0 text-sm text-muted">@{domain}</span>
            </div>
          </Field>
          <Field label="Password" error={error} help="At least 10 characters.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
          </Field>
          <div className="flex justify-between">
            <Button variant="ghost" type="button" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button variant="primary" type="submit" loading={busy}>
              Finish setup
            </Button>
          </div>
        </form>
      )}
    </AuthShell>
  );
}

function ProviderChoice(props: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={props.selected}
      aria-disabled={props.disabled}
      tabIndex={props.disabled ? -1 : 0}
      onClick={() => !props.disabled && props.onSelect()}
      onKeyDown={(e) => {
        if (!props.disabled && (e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) {
          e.preventDefault();
          props.onSelect();
        }
      }}
      className={`block w-full rounded-xl border p-3.5 text-left transition-colors ${
        props.disabled ? 'cursor-not-allowed border-line opacity-60' : props.selected ? 'cursor-pointer border-accent bg-accent-soft' : 'cursor-pointer border-line hover:bg-hover'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${props.selected ? 'border-accent' : 'border-line'}`}>
          {props.selected && <span className="size-2 rounded-full bg-accent" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {props.title}
            {props.badge && <span className="rounded-full bg-panel2 px-2 py-0.5 text-[11px] font-medium text-muted">{props.badge}</span>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">{props.description}</p>
          {props.children}
        </div>
      </div>
    </div>
  );
}

export function ForceTwoFactorPage({ instance }: { instance: Instance }) {
  const qc = useQueryClient();
  return (
    <AuthShell instance={instance} wide>
      <h1 className="text-2xl font-semibold tracking-tight">Set up 2-step verification</h1>
      <p className="mt-1 mb-5 text-sm text-muted">Your administrator requires two-factor authentication before you can use {instance.name}.</p>
      <TwoFactorSetup onDone={() => qc.invalidateQueries({ queryKey: ['me'] })} />
      <button className="mt-6 text-sm text-muted hover:text-fg" onClick={() => void signOut()}>
        Sign out
      </button>
    </AuthShell>
  );
}

/** An administrator asked for a new password: choose one before anything else. */
export function ForcePasswordPage({ instance, email }: { instance: Instance; email: string }) {
  const qc = useQueryClient();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell instance={instance}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (next !== confirm) return setError('The passwords don’t match');
          setBusy(true);
          setError(null);
          try {
            await api.post('/api/account/password/required', { next });
            await qc.invalidateQueries({ queryKey: ['me'] });
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
          <KeyRound className="size-6" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
          <p className="mt-1 text-sm text-muted">
            Your administrator asked you to set a new password for <b className="text-fg">{email}</b> before you continue. Your other devices will be signed out.
          </p>
        </div>
        {/* Lets password managers save the new password under the right account. */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <Field label="New password" help="A long one you don’t use anywhere else.">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} autoFocus required />
        </Field>
        <Field label="Type it again" error={error}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Save and continue
        </Button>
        <button type="button" className="block w-full text-center text-sm text-muted hover:text-fg" onClick={() => void signOut()}>
          Sign out
        </button>
      </form>
    </AuthShell>
  );
}

/** "Forgot password?": a reset link goes to the account's confirmed recovery email. */
export function ForgotPage({ instance }: { instance: Instance }) {
  const [params] = useSearchParams();
  const signInPath = useSignInPath();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (sent) {
    return (
      <AuthShell instance={instance}>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
          <Mail className="size-6" aria-hidden />
        </div>
        <h1 className="mt-4 text-xl font-semibold" role="status">
          Check your other inbox
        </h1>
        <p className="mt-2 text-sm text-muted">
          If <b className="text-fg">{email}</b> has a confirmed recovery email, a link to choose a new password is on its way there. It works once, for one hour.
        </p>
        <p className="mt-3 text-sm text-muted">Nothing arrived? Check spam, or ask an administrator of {instance.name} to send you a sign-in link.</p>
        <Link to={signInPath} className="mt-6 inline-flex text-sm font-medium text-accent-ink hover:underline">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell instance={instance}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.post('/api/auth/forgot', { email: email.trim() });
            setSent(true);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
          <p className="mt-1 text-sm text-muted">Enter your {instance.name} address. We’ll send a reset link to the recovery email you set up.</p>
        </div>
        <Field label="Email address" error={error}>
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Send reset link
        </Button>
        <p className="text-center text-sm">
          <Link to={signInPath} className="font-medium text-accent-ink hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

// One-time links must only be redeemed once, even when React runs effects twice in development.
const redeemed = new Map<string, Promise<{ email: string }>>();

/** The link in the "confirm your recovery email" message. */
export function VerifyRecoveryPage({ instance, signedIn }: { instance: Instance; signedIn: boolean }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<{ ok: boolean; email?: string; error?: string } | null>(token ? null : { ok: false, error: 'This link is incomplete.' });
  useEffect(() => {
    if (!token) return;
    if (!redeemed.has(token)) redeemed.set(token, api.post<{ email: string }>('/api/auth/verify-recovery', { token }));
    redeemed
      .get(token)!
      .then((r) => setState({ ok: true, email: r.email }))
      .catch((err) => setState({ ok: false, error: (err as Error).message }));
  }, [token]);
  return (
    <AuthShell instance={instance}>
      {!state ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-6" />
        </div>
      ) : state.ok ? (
        <div role="status">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok">
            <ShieldCheck className="size-6" aria-hidden />
          </div>
          <h1 className="mt-4 text-xl font-semibold">Recovery email confirmed</h1>
          <p className="mt-2 text-sm text-muted">
            If you ever forget your password, use “Forgot password?” on the sign-in page and a reset link goes to <b className="text-fg">{state.email}</b>.
          </p>
        </div>
      ) : (
        <div role="alert">
          <h1 className="text-xl font-semibold">This link didn’t work</h1>
          <p className="mt-2 text-sm text-muted">{state.error} You can send a new confirmation from Settings → Security.</p>
        </div>
      )}
      <Link to={signedIn ? '/settings/security' : '/login'} className="mt-6 inline-flex text-sm font-medium text-accent-ink hover:underline">
        {signedIn ? 'Go to Security settings' : 'Go to sign in'}
      </Link>
    </AuthShell>
  );
}
