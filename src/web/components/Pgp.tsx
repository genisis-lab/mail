/** PGP in the conversation and compose: unlocking your key, decrypting, signature checks, saving attached keys. */
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Download, KeyRound, Lock, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { PrivateKey } from 'openpgp';
import type { MessageDetail } from '../../shared/types';
import { api, linkUrl } from '../lib/api';
import { fileSize } from '../lib/format';
import {
  armoredIn,
  decryptFile,
  decryptMime,
  decryptText,
  pgpKind,
  publicKeyFrom,
  signedPart,
  unlockKey,
  unlockedKey,
  verifyCleartext,
  verifyDetached,
  type DecryptedFile,
  type SignatureStatus,
} from '../lib/pgp';
import { useSession } from '../lib/session';
import { useToast } from './toast';
import { Button, Field, Input, Modal } from './ui';

type KnownKeys = Record<string, { fingerprint: string; armored: string }[]>;

const lookupQuery = (addresses: string[]) => {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))].sort();
  return {
    queryKey: ['pgp-lookup', list],
    queryFn: () => api.post<{ keys: KnownKeys }>('/api/me/pgp/lookup', { addresses: list }).then((r) => r.keys),
    staleTime: 60_000,
  };
};

/** Public keys known for these addresses (saved ones, and ones published by people on this server). */
export function useKeyLookup(addresses: string[], enabled = true) {
  return useQuery({ ...lookupQuery(addresses), enabled: enabled && addresses.length > 0 });
}

export function lookupKeys(qc: QueryClient, addresses: string[]): Promise<KnownKeys> {
  return addresses.length ? qc.fetchQuery(lookupQuery(addresses)) : Promise.resolve({});
}

/** A file the browser downloads itself (an attachment, the raw message). */
export async function bytesOf(url: string): Promise<Uint8Array> {
  const res = await fetch(linkUrl(url), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Couldn’t download it (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// ── Unlocking your key ──────────────────────────────────────────────────────

/** Ask for the passphrase once per tab; `dialog` must be rendered by the caller. */
export function useUnlock() {
  const { user } = useSession();
  const [pending, setPending] = useState<((key: PrivateKey | null) => void) | null>(null);
  const unlock = useCallback(
    (): Promise<PrivateKey | null> => {
      const key = unlockedKey(user.id);
      return key ? Promise.resolve(key) : new Promise((resolve) => setPending(() => resolve));
    },
    [user.id],
  );
  const dialog = pending && (
    <UnlockDialog
      onDone={(key) => {
        pending(key);
        setPending(null);
      }}
    />
  );
  return { unlock, dialog };
}

function UnlockDialog({ onDone }: { onDone: (key: PrivateKey | null) => void }) {
  const { user } = useSession();
  const form = useId();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={() => onDone(null)}
      title="Unlock your PGP key"
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={form} loading={busy} disabled={!passphrase}>
            Unlock
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onDone(await unlockKey(user.id, passphrase));
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <Field label="Passphrase" help="Your key stays unlocked until you close this tab." error={error}>
          <Input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

// ── Reading ─────────────────────────────────────────────────────────────────

interface Opened {
  text: string | null;
  html: string | null;
  files: DecryptedFile[];
  signature: SignatureStatus | null;
}

/** Messages decrypted in this tab (memory only), so they stay open and replies can quote them. */
const opened = new Map<number, Opened>();

/**
 * A reply or forward of a message decrypted here quotes what it said, not its
 * ciphertext. Only for a reply that starts encrypted: the quote never reaches the server in the clear.
 */
export function withDecryptedQuote(html: string, messageId: number): string {
  const text = opened.get(messageId)?.text;
  if (!text) return html;
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // An inline message's armored block, or the empty quote of a PGP/MIME one (its body was all attachments).
  const block = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
  const empty = '<pre style="white-space:pre-wrap;font-family:inherit"></pre>';
  return block.test(html) ? html.replace(block, () => safe) : html.replace(empty, () => `<pre style="white-space:pre-wrap;font-family:inherit">${safe}</pre>`);
}

const notForYou = (err: unknown) =>
  /session key|decryption key|no (secret|private) key/i.test((err as Error).message)
    ? 'This message wasn’t encrypted to the key in this browser, so it can’t be decrypted here.'
    : `Couldn’t decrypt this message: ${(err as Error).message.replace(/^Error decrypting message: /, '')}`;

/** Someone's public key attached to a message (a .asc key file). */
const isKeyFile = (a: MessageDetail['attachments'][number]) =>
  a.contentType === 'application/pgp-keys' || (/\.asc$/i.test(a.filename) && !/^(signature|encrypted)\.asc$/i.test(a.filename) && !/pgp-(signature|encrypted)/.test(a.contentType));

/**
 * A message's PGP side: "This message is encrypted" and Decrypt, the signature
 * check, and Save key for an attached public key. The body itself (decrypted,
 * or the signed text) is rendered by `children`, through the usual sanitizer.
 */
export function PgpMessage({ m, children }: { m: MessageDetail; children: (body: { html: string | null; text: string | null; decrypted: boolean }) => ReactNode }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { unlock, dialog } = useUnlock();
  const kind = pgpKind(m);
  const encrypted = kind === 'encrypted' || kind === 'encrypted-mime';
  const [result, setResult] = useState<Opened | null>(() => opened.get(m.id) ?? null);
  const [signed, setSigned] = useState<{ text: string | null; signature: SignatureStatus | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decrypt = async () => {
    const key = await unlock();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const senderKeys = ((await lookupKeys(qc, [m.from.address]))[m.from.address.toLowerCase()] ?? []).map((k) => k.armored);
      let r: Opened;
      if (kind === 'encrypted-mime') {
        const part = m.attachments.find((a) => a.contentType !== 'application/pgp-encrypted');
        if (!part) throw new Error('the encrypted part is missing');
        const d = await decryptMime(await bytesOf(`/api/attachments/${part.id}`), key, senderKeys);
        r = { text: d.text, html: d.html, files: d.attachments, signature: d.signature };
      } else {
        const d = await decryptText(armoredIn(m)!, key, senderKeys);
        // Files sent with inline PGP are encrypted one by one (name.pgp).
        const files = await Promise.all(
          m.attachments
            .filter((a) => /\.(pgp|gpg)$/i.test(a.filename))
            .map(async (a) => {
              const f = await decryptFile(await bytesOf(`/api/attachments/${a.id}`), key);
              return { filename: f.filename || a.filename.replace(/\.(pgp|gpg)$/i, ''), contentType: 'application/octet-stream', data: f.data };
            }),
        );
        r = { text: d.text, html: null, files, signature: d.signature };
      }
      opened.set(m.id, r);
      setResult(r);
    } catch (err) {
      setError(notForYou(err));
    } finally {
      setBusy(false);
    }
  };

  // Already unlocked in this tab: open it straight away.
  useEffect(() => {
    if (encrypted && !result && unlockedKey(user.id)) void decrypt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);

  // Signed (not encrypted): check the signature against the keys known for the sender.
  useEffect(() => {
    if (kind !== 'signed' && kind !== 'signed-mime') return;
    let live = true;
    (async () => {
      const senderKeys = ((await lookupKeys(qc, [m.from.address]))[m.from.address.toLowerCase()] ?? []).map((k) => k.armored);
      if (kind === 'signed') return verifyCleartext(armoredIn(m, true)!, senderKeys);
      const sig = m.attachments.find((a) => a.contentType === 'application/pgp-signature')!;
      const [raw, signature] = await Promise.all([bytesOf(`/api/mail/messages/${m.id}/raw`), bytesOf(`/api/attachments/${sig.id}`)]);
      const part = signedPart(raw);
      if (!part) throw new Error('No signed part');
      return { text: null, signature: await verifyDetached(part, new TextDecoder().decode(signature), senderKeys) };
    })().then(
      (r) => live && setSigned(r),
      () => live && setSigned({ text: null, signature: 'error' }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, kind]);

  const signature = result?.signature ?? signed?.signature ?? null;
  const sender = m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address;

  return (
    <>
      {dialog}
      {encrypted && !result && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-accent-softer px-4 py-3 text-[13px]">
          <Lock className="size-4 shrink-0 text-accent-ink" aria-hidden />
          <span className="min-w-0 flex-1">
            <b>This message is encrypted.</b> It’s decrypted here in your browser, never on the server.
          </span>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void decrypt()}>
            Decrypt
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-3 text-[13px] text-danger">
          {error}
        </p>
      )}
      {signature === 'valid' && (
        <p className="mb-3 flex items-center gap-1.5 text-[13px] text-ok">
          <ShieldCheck className="size-4 shrink-0" aria-hidden /> Signed by {sender}
        </p>
      )}
      {signature === 'bad' && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-4 py-2.5 text-[13px]">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <span>
            <b>The signature doesn’t match.</b> This message may have been changed after it was signed, or it wasn’t signed with {m.from.address}’s key.
          </span>
        </div>
      )}
      {signature === 'unknown' && (
        <p className="mb-3 flex items-center gap-1.5 text-[13px] text-muted">
          <ShieldQuestion className="size-4 shrink-0" aria-hidden /> Signed with a key you haven’t saved, so who signed it can’t be checked.
        </p>
      )}
      {signature === 'error' && (
        <p className="mb-3 flex items-center gap-1.5 text-[13px] text-muted">
          <ShieldQuestion className="size-4 shrink-0" aria-hidden /> This message is signed, but its signature couldn’t be checked.
        </p>
      )}
      {m.attachments.filter(isKeyFile).map((a) => (
        <div key={a.id} className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-panel2 px-4 py-2.5 text-[13px]">
          <KeyRound className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            A PGP public key is attached ({a.filename}). Save it to send encrypted mail to {m.from.name || m.from.address} and check their signatures.
          </span>
          <Button
            size="sm"
            onClick={async () => {
              try {
                const armored = await publicKeyFrom(await bytesOf(`/api/attachments/${a.id}`));
                const r = await api.post<{ updated: boolean }>('/api/me/pgp/keys', { armored });
                qc.invalidateQueries({ queryKey: ['pgp'] });
                qc.invalidateQueries({ queryKey: ['pgp-lookup'] });
                toast(r.updated ? 'You already had this key; it’s up to date now' : 'Key saved');
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              }
            }}
          >
            Save key
          </Button>
        </div>
      ))}
      {/* shortcut: pictures inside a decrypted PGP/MIME message (cid:) show as downloads, not inline; map them to blob URLs if people ask. */}
      {result
        ? children({ html: result.html, text: result.text, decrypted: true })
        : encrypted
          ? null
          : children({ ...(signed?.text != null ? { html: null, text: signed.text } : { html: m.html, text: m.text }), decrypted: false })}
      {result && result.files.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {result.files.map((f, i) => (
            <button
              key={i}
              type="button"
              onClick={() => saveFile(f.filename, f.data as BlobPart, f.contentType)}
              className="inline-flex max-w-72 items-center gap-2 rounded-lg border border-line bg-panel2 py-1.5 pr-3 pl-2.5 text-[13px] hover:bg-hover"
              aria-label={`Download ${f.filename}, decrypted`}
            >
              <Download className="size-3.5 shrink-0 text-muted" aria-hidden />
              <span className="truncate font-medium">{f.filename}</span>
              <span className="shrink-0 text-xs text-muted">{fileSize(f.data.length)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Download something made in this browser (a decrypted file, your key) without it touching the server. */
export function saveFile(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
