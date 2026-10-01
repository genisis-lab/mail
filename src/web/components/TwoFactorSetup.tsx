import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Field, Input, Spinner } from './ui';
import { useToast } from './toast';

/** Enrol a TOTP authenticator app and show recovery codes. */
export function TwoFactorSetup({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    api
      .post<{ secret: string; uri: string }>('/api/account/2fa/setup')
      .then(async (r) => {
        setSecret(r.secret);
        setQr(await QRCode.toDataURL(r.uri, { margin: 1, width: 200 }));
      })
      .catch((e) => setError(e.message));
  }, []);

  if (codes) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2 text-ok">
          <ShieldCheck className="size-5" />
          <span className="font-medium">Two-factor authentication is on</span>
        </div>
        <p className="mb-3 text-sm text-muted">
          Save these recovery codes somewhere safe. Each one can be used once if you lose access to your authenticator.
        </p>
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-panel2 p-4 font-mono text-sm">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            icon={<Copy className="size-4" />}
            onClick={() => {
              void navigator.clipboard.writeText(codes.join('\n'));
              toast('Recovery codes copied');
            }}
          >
            Copy
          </Button>
          <Button variant="primary" onClick={onDone}>
            I’ve saved them
          </Button>
        </div>
      </div>
    );
  }

  if (!secret) return error ? <p className="text-sm text-danger">{error}</p> : <Spinner />;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await api.post<{ recoveryCodes: string[] }>('/api/account/2fa/enable', { code });
          setCodes(r.recoveryCodes);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Open an authenticator app (1Password, Authy, Google Authenticator, Bitwarden…).</li>
        <li>Scan the QR code, or enter the key manually.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        {qr && <img src={qr} alt="Authenticator QR code" className="size-44 rounded-xl border border-line bg-white p-2" />}
        <div className="min-w-0 flex-1 space-y-3">
          <Field label="Setup key">
            <code className="block rounded-lg bg-panel2 px-3 py-2 font-mono text-[13px] break-all select-all">{secret.match(/.{1,4}/g)?.join(' ')}</code>
          </Field>
          <Field label="Verification code" error={error}>
            <Input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={code.replace(/\s/g, '').length < 6}>
            Turn on
          </Button>
        </div>
      </div>
    </form>
  );
}
