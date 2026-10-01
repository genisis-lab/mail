import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Globe, KeyRound, Mail, ShieldCheck, Sparkles } from 'lucide-react';
import { APP_NAME, APP_TAGLINE } from '../../shared/brand';
import { api } from '../lib/api';
import type { Instance } from '../lib/session';
import { Logo } from '../components/Logo';
import { TwoFactorSetup } from '../components/TwoFactorSetup';
import { Button, Field, Input, Select } from '../components/ui';

function AuthShell({ instance, children, wide }: { instance: Instance; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-[420px]'}`}>
        <div className="mb-8 flex justify-center">
          <Logo name={instance.name || APP_NAME} />
        </div>
        <div className="animate-pop rounded-3xl border border-line bg-panel p-8 shadow-panel max-sm:p-6">{children}</div>
        <p className="mt-6 text-center text-xs text-faint">
          {APP_NAME} {instance.version} · {APP_TAGLINE}
        </p>
      </div>
    </div>
  );
}

export function LoginPage({ instance, mfaPending, next }: { instance: Instance; mfaPending: boolean; next: string }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<'password' | 'mfa'>(mfaPending ? 'mfa' : 'password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    if (next && next !== '/login') navigate(next, { replace: true });
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
              const r = await api.post<{ mfaRequired?: boolean }>('/api/auth/login', { email, password });
              if (r.mfaRequired) setStep('mfa');
              else await done();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-4"
        >
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="mt-1 text-sm text-muted">to continue to {instance.name}</p>
          </div>
          {instance.loginMessage && <div className="rounded-xl bg-accent-softer px-4 py-3 text-sm text-fg">{instance.loginMessage}</div>}
          <Field label="Email address">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </Field>
          <Field label="Password" error={error}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Sign in
          </Button>
          {instance.registration !== 'closed' && (
            <p className="text-center text-sm text-muted">
              New here?{' '}
              <Link to="/register" className="font-medium text-accent hover:underline">
                Create an account
              </Link>
            </p>
          )}
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.post('/api/auth/mfa', { code });
              await done();
            } catch (err) {
              setError((err as Error).message);
              if ((err as any).status === 401 && /expired/i.test((err as Error).message)) setStep('password');
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-4"
        >
          <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
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
              await api.post('/api/auth/logout').catch(() => {});
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

export function RegisterPage({ instance }: { instance: Instance }) {
  const qc = useQueryClient();
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
  if (closed || (invite && !invite.valid)) {
    return (
      <AuthShell instance={instance}>
        <h1 className="text-xl font-semibold">{invite && !invite.valid ? 'Invitation expired' : 'Registration is invite-only'}</h1>
        <p className="mt-2 text-sm text-muted">Ask an administrator of {instance.name} for an invitation link.</p>
        <Link to="/login" className="mt-6 inline-flex text-sm font-medium text-accent hover:underline">
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
            await api.post('/api/auth/register', { localPart, domain, name, password, invite: inviteToken ?? undefined });
            await qc.invalidateQueries({ queryKey: ['me'] });
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
          <p className="mt-1 text-sm text-muted">Get a mailbox on {instance.name}</p>
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
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
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

  const steps = [
    { icon: <Sparkles className="size-4" />, label: 'Welcome' },
    { icon: <Globe className="size-4" />, label: 'Domain' },
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
            Let’s set up your mail server. You’ll add your first domain and create the owner account. Next, in the admin panel, you’ll connect an email
            provider (Cloudflare, Resend, SES, Postmark, SMTP and more) for sending and receiving.
          </p>
          <Field label="Name this instance" help="Shown on the sign-in page and in the browser tab.">
            <Input value={instanceName} onChange={(e) => setInstanceName(e.target.value)} placeholder="Acme Mail" autoFocus />
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
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.post('/api/setup', { instanceName, domain, localPart, name, password });
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
            <Button variant="ghost" type="button" onClick={() => setStep(1)}>
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

export function ForceTwoFactorPage({ instance }: { instance: Instance }) {
  const qc = useQueryClient();
  return (
    <AuthShell instance={instance} wide>
      <h1 className="text-2xl font-semibold tracking-tight">Set up 2-step verification</h1>
      <p className="mt-1 mb-5 text-sm text-muted">Your administrator requires two-factor authentication before you can use {instance.name}.</p>
      <TwoFactorSetup onDone={() => qc.invalidateQueries({ queryKey: ['me'] })} />
      <button
        className="mt-6 text-sm text-muted hover:text-fg"
        onClick={async () => {
          await api.post('/api/auth/logout');
          qc.invalidateQueries({ queryKey: ['me'] });
        }}
      >
        Sign out
      </button>
    </AuthShell>
  );
}
