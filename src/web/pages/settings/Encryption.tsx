import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, KeyRound, Plus, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { longDate } from '../../lib/format';
import { backupKey, restoreKey, useStoredKey, createKey, forgetKey, formatFingerprint, importPrivateKey, keyInfo, publicKeyFrom, publicKeyOf, storeKey } from '../../lib/pgp';
import { useSession } from '../../lib/session';
import { saveFile } from '../../components/Pgp';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, Spinner, Textarea } from '../../components/ui';

interface ServerKey {
  id: number;
  fingerprint: string;
  name: string;
  emails: string[];
  armored: string;
  createdAt: number;
}

function usePgpKeys() {
  return useQuery({ queryKey: ['pgp'], queryFn: () => api.get<{ published: ServerKey | null; keys: ServerKey[]; backup: { fingerprint: string; updatedAt: number } | null }>('/api/me/pgp') });
}

/** PGP: your own key (with an encrypted backup) and the public keys of people you write to. */
export function EncryptionTab() {
  return (
    <div className="space-y-6">
      <YourKeyCard />
      <SavedKeysCard />
    </div>
  );
}

function YourKeyCard() {
  const { user, instance } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const server = usePgpKeys();
  const local = useStoredKey(user.id);
  const [dialog, setDialog] = useState<'create' | 'import' | null>(null);
  const [busy, setBusy] = useState(false);
  const info = useQuery({ queryKey: ['pgp-local', local], queryFn: async () => ({ ...(await keyInfo(local!)), publicKey: await publicKeyOf(local!) }), enabled: !!local });

  const published = server.data?.published ?? null;
  const isPublished = !!info.data && published?.fingerprint === info.data.fingerprint;

  const publish = async (publicKey: string) => {
    try {
      await api.put('/api/me/pgp/published', { armored: publicKey });
      qc.invalidateQueries({ queryKey: ['pgp'] });
      qc.invalidateQueries({ queryKey: ['pgp-lookup'] });
      return true;
    } catch (err) {
      toast({ message: `Your key is saved in this browser, but couldn’t be published: ${(err as Error).message}`, tone: 'error' });
      return false;
    }
  };

  const saveBackup = async (key: string) => {
    setBusy(true);
    try {
      await backupKey(user.id, key);
      await qc.invalidateQueries({ queryKey: ['pgp'] });
      toast('Encrypted key backed up. Use your PGP passphrase to unlock it on another browser.');
      return true;
    } catch (err) {
      toast({ message: `Backup failed; keep a downloaded copy of your key. ${(err as Error).message}`, tone: 'error' });
      return false;
    } finally { setBusy(false); }
  };

  /** Keep the protected key, back it up, and publish only its public half. */
  const adopt = async (privateKey: string, done: string) => {
    storeKey(user.id, privateKey);
    const backedUp = await saveBackup(privateKey);
    setDialog(null);
    if (backedUp && await publish(await publicKeyOf(privateKey))) toast(done);
  };

  const unpublish = async () => {
    if (!window.confirm(`Stop publishing your public key? People on ${instance.name} won’t be able to send you encrypted mail until you publish it again.`)) return;
    await api.del('/api/me/pgp/published');
    qc.invalidateQueries({ queryKey: ['pgp'] });
    qc.invalidateQueries({ queryKey: ['pgp-lookup'] });
    toast('Your public key is no longer published');
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted" aria-hidden /> Encryption (PGP)
        </span>
      }
      description="Send and read encrypted mail, and sign what you send. An encrypted backup lets you use your key in other browsers. Only your PGP passphrase unlocks it, on your device; the server never receives that passphrase. Losing it means losing access, even if you reset your account password."
    >
      {local ? (
        !info.data ? (
          info.isError ? <p className="text-sm text-danger">The key in this browser couldn’t be read. Remove it and import it again.</p> : <Spinner />
        ) : (
          <div className="grid gap-4">
            <div className="text-sm">
              <p className="font-medium break-all">{info.data.userIds.join(', ')}</p>
              <p className="mt-1 font-mono text-[13px] break-all text-muted">{formatFingerprint(info.data.fingerprint)}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                created {longDate(info.data.created.getTime())}
                {server.data?.backup?.fingerprint === info.data.fingerprint ? <Badge tone="ok">encrypted backup saved</Badge> : <Badge tone="warn">no matching server backup</Badge>}
                {isPublished ? <Badge tone="ok">published on {instance.name}</Badge> : <Badge tone="warn">not published</Badge>}
              </p>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              {isPublished
                ? `People on ${instance.name} get your public key automatically when they write to you. Send it to anyone else who wants to write to you encrypted.`
                : `Publish your public key so people on ${instance.name} can send you encrypted mail.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={() => void saveBackup(local)}>Save encrypted backup</Button>
              {server.data?.backup && (
                <Button icon={<Download className="size-4" />} onClick={async () => {
                  try {
                    const { backup } = await api.get<{ backup: { armored: string; fingerprint: string } | null }>('/api/me/pgp/backup');
                    if (backup) saveFile(`${user.email}-${backup.fingerprint}-backup.asc`, backup.armored, 'application/pgp-keys');
                  } catch (err) { toast({ message: (err as Error).message, tone: 'error' }); }
                }}>Download server backup</Button>
              )}
              {server.data?.backup && (
                <Button variant="ghost" onClick={async () => {
                  if (!window.confirm('Delete your encrypted server backup? Download a private-key copy first. Other browsers will need that file to read encrypted mail.')) return;
                  try {
                    await api.del('/api/me/pgp/backup');
                    await qc.invalidateQueries({ queryKey: ['pgp'] });
                    toast('Server backup deleted. Local copies are unchanged.');
                  } catch (err) { toast({ message: (err as Error).message, tone: 'error' }); }
                }}>Delete server backup</Button>
              )}
              {!isPublished && (
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    if (await publish(info.data!.publicKey)) toast('Your public key is published');
                    setBusy(false);
                  }}
                >
                  Publish public key
                </Button>
              )}
              <Button icon={<Download className="size-4" />} onClick={() => saveFile(`${user.email}-public-key.asc`, info.data!.publicKey, 'application/pgp-keys')}>
                Download public key
              </Button>
              <Button
                icon={<Copy className="size-4" />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(info.data!.publicKey);
                    toast('Public key copied');
                  } catch {
                    toast({ message: 'Couldn’t copy; download it instead', tone: 'error' });
                  }
                }}
              >
                Copy public key
              </Button>
              <Button
                icon={<Download className="size-4" />}
                onClick={() => {
                  saveFile(`${user.email}-private-key.asc`, local, 'application/pgp-keys');
                  toast('Keep this file somewhere safe. It’s protected by your passphrase; never share it.');
                }}
              >
                Back up private key
              </Button>
              <Button
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                onClick={() => {
                  if (!window.confirm('Remove your private key from this browser? You won’t be able to read encrypted mail or sign here until you restore its encrypted backup or import it again. If this is your only copy, back it up first: mail encrypted to it can’t be read without it.')) return;
                  forgetKey(user.id);
                  toast('Key removed from this browser');
                }}
              >
                Remove from this browser
              </Button>
              {isPublished && (
                <Button variant="ghost" onClick={() => void unpublish()}>
                  Stop publishing
                </Button>
              )}
            </div>
            {published && !isPublished && (
              <p className="text-xs text-muted">
                A different key ({formatFingerprint(published.fingerprint).slice(-19)}) is published now. Publishing this one replaces it.
              </p>
            )}
          </div>
        )
      ) : (
        <div className="grid gap-4">
          {published ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-panel2 px-4 py-3 text-[13px]">
              <span className="min-w-0 flex-1">
                Your public key <span className="font-mono">{formatFingerprint(published.fingerprint).slice(-19)}</span> is published, but its private key isn’t in this browser. Restore its encrypted backup or import it to read encrypted mail here.
              </span>
              <Button size="sm" variant="ghost" onClick={() => void unpublish()}>
                Stop publishing
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted">You don’t have a key in this browser yet. Create one for {user.email}, or import the key you already use.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {server.data?.backup && <Button onClick={async () => {
              try { await restoreKey(user.id); } catch (err) { toast({ message: (err as Error).message, tone: 'error' }); }
            }}>Restore encrypted backup</Button>}
            <Button variant="primary" disabled={server.isLoading || !!server.data?.backup} icon={<Plus className="size-4" />} onClick={() => setDialog('create')}>
              Create a key
            </Button>
            <Button icon={<Upload className="size-4" />} onClick={() => setDialog('import')}>
              Import a key
            </Button>
          </div>
        </div>
      )}
      <KeyDialog mode={dialog} onClose={() => setDialog(null)} onKey={adopt} />
    </Card>
  );
}

/** Create a key pair, or import a private key, protected by a passphrase. */
function KeyDialog({ mode, onClose, onKey }: { mode: 'create' | 'import' | null; onClose: () => void; onKey: (privateKey: string, done: string) => Promise<void> }) {
  const { user } = useSession();
  const [armored, setArmored] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setArmored('');
    setPassphrase('');
    setConfirm('');
    setError(null);
  }, [mode]);
  const creating = mode === 'create';
  const mismatch = creating && !!confirm && passphrase !== confirm;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (creating) await onKey((await createKey(user.name, user.email, passphrase)).privateKey, 'Your key is ready and your public key is published');
      else await onKey(await importPrivateKey(armored, passphrase), 'Key imported');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!mode}
      onClose={onClose}
      title={creating ? 'Create a PGP key' : 'Import your PGP key'}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!passphrase || mismatch || (creating ? passphrase !== confirm : !armored.trim())} onClick={() => void submit()}>
            {creating ? 'Create key' : 'Import key'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <p className="text-[13px] text-muted">Your passphrase-protected private key will be backed up to your account for use in other browsers. Its passphrase stays on this device. Keep a downloaded copy too.</p>
        {creating ? (
          <p className="text-[13px] text-muted">
            A new key for <b>{user.email}</b>. Choose a passphrase you’ll remember: you type it to read encrypted mail, and nobody can recover it for you.
          </p>
        ) : (
          <Field label="Private key" help="Paste it (it starts with -----BEGIN PGP PRIVATE KEY BLOCK-----) or choose the file you backed it up to.">
            <Textarea value={armored} onChange={(e) => setArmored(e.target.value)} className="min-h-32 font-mono text-xs" spellCheck={false} autoFocus />
            <span className="mt-2 block">
              <Button size="sm" icon={<Upload className="size-4" />} onClick={() => file.current?.click()}>
                Choose file
              </Button>
              <input
                ref={file}
                type="file"
                accept=".asc,.key,.txt,.pgp,.gpg"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) setArmored(await f.text());
                }}
              />
            </span>
          </Field>
        )}
        <Field label="Passphrase" help={creating ? undefined : 'The passphrase of this key. A key without one gets this passphrase.'}>
          <Input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus={creating} />
        </Field>
        {creating && (
          <Field label="Confirm passphrase" error={mismatch ? 'Passphrases don’t match' : null}>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Other people's public keys, kept on the server (they're public) for encrypting to them and checking their signatures. */
function SavedKeysCard() {
  const { instance } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = usePgpKeys();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const save = async (data: string | Uint8Array) => {
    setBusy(true);
    try {
      const r = await api.post<{ key: ServerKey; updated: boolean }>('/api/me/pgp/keys', { armored: await publicKeyFrom(data) });
      qc.invalidateQueries({ queryKey: ['pgp'] });
      qc.invalidateQueries({ queryKey: ['pgp-lookup'] });
      toast(r.updated ? `Updated the key for ${r.key.emails[0] ?? r.key.name}` : `Saved the key for ${r.key.emails[0] ?? r.key.name}`);
      setAdding(false);
      setText('');
    } catch (err) {
      toast({ message: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Other people’s keys"
      description={`Public keys of people you write to. People on ${instance.name} who published theirs don’t need to be added. You can also save a key someone attaches to an email.`}
      actions={
        <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
          Add a key
        </Button>
      }
    >
      {keys.isLoading ? (
        <Spinner />
      ) : !keys.data?.keys.length ? (
        <Empty icon={<KeyRound className="size-7" />} title="No saved keys yet" />
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {keys.data.keys.map((k) => (
            <li key={k.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-all">
                  {k.name || k.emails[0]} {k.name && k.emails.length > 0 && <span className="font-normal text-muted">&lt;{k.emails.join('>, <')}&gt;</span>}
                </p>
                <p className="font-mono text-xs break-all text-muted">{formatFingerprint(k.fingerprint)}</p>
              </div>
              <IconButton
                size="sm"
                label={`Remove the key for ${k.emails[0] ?? k.name}`}
                onClick={async () => {
                  if (!window.confirm(`Remove the key for ${k.emails[0] ?? k.name}? You won’t be able to send them encrypted mail or check their signatures until you add it again.`)) return;
                  await api.del(`/api/me/pgp/keys/${k.id}`);
                  qc.invalidateQueries({ queryKey: ['pgp'] });
                  qc.invalidateQueries({ queryKey: ['pgp-lookup'] });
                  toast('Key removed');
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add someone’s public key"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void save(text)}>
              Save key
            </Button>
          </>
        }
      >
        <Field label="Public key" help="Paste it (it starts with -----BEGIN PGP PUBLIC KEY BLOCK-----) or choose a key file.">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-32 font-mono text-xs" spellCheck={false} autoFocus />
        </Field>
        <Button className="mt-3" size="sm" icon={<Upload className="size-4" />} disabled={busy} onClick={() => file.current?.click()}>
          Choose file
        </Button>
        <input
          ref={file}
          type="file"
          accept=".asc,.key,.txt,.pgp,.gpg"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void save(new Uint8Array(await f.arrayBuffer()));
          }}
        />
      </Modal>
    </Card>
  );
}
