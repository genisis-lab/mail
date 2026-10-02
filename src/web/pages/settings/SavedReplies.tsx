import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useSavedReplies } from '../../components/Compose';
import { RichEditor } from '../../components/RichEditor';
import { useToast } from '../../components/toast';
import { Button, Card, Empty, Field, IconButton, Input, Modal, Spinner } from '../../components/ui';

interface Reply {
  id?: number;
  name: string;
  html: string;
}

/** Saved replies (canned responses), inserted from the compose toolbar. */
export function SavedRepliesTab() {
  const replies = useSavedReplies();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Reply | null>(null);
  return (
    <Card
      title="Saved replies"
      description="Text you send often. Insert one from the compose toolbar (the page icon), or save a message you’re writing as a new one."
      actions={
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ name: '', html: '' })}>
          New reply
        </Button>
      }
    >
      {replies.isLoading ? (
        <Spinner />
      ) : !replies.data?.length ? (
        <Empty icon={<FileText className="size-7" />} title="No saved replies yet" />
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {replies.data.map((r) => (
            <li key={r.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.name}</p>
                <p className="line-clamp-2 text-[13px] text-muted">{DOMPurify.sanitize(r.html, { ALLOWED_TAGS: [] }).replace(/\s+/g, ' ').trim()}</p>
              </div>
              <IconButton size="sm" label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton
                size="sm"
                label={`Delete ${r.name}`}
                onClick={async () => {
                  if (!window.confirm(`Delete the saved reply “${r.name}”?`)) return;
                  await api.del(`/api/me/saved-replies/${r.id}`);
                  qc.invalidateQueries({ queryKey: ['me', 'saved-replies'] });
                  toast('Saved reply deleted');
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ReplyDialog value={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function ReplyDialog({ value, onClose }: { value: Reply | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<unknown>(null);
  const k = value ? value.id ?? 'new' : null;
  if (k !== key) {
    setKey(k);
    setName(value?.name ?? '');
    setHtml(value?.html ?? '');
  }
  const empty = !DOMPurify.sanitize(html, { ALLOWED_TAGS: [] }).trim();
  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title={value?.id ? 'Edit saved reply' : 'New saved reply'}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || empty}
            onClick={async () => {
              setBusy(true);
              try {
                if (value?.id) await api.put(`/api/me/saved-replies/${value.id}`, { name, html });
                else await api.post('/api/me/saved-replies', { name, html });
                qc.invalidateQueries({ queryKey: ['me', 'saved-replies'] });
                onClose();
              } catch (err) {
                toast({ message: (err as Error).message, tone: 'error' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Thanks, got it" autoFocus />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Text</span>
          <div className="rounded-xl border border-line-strong px-3 py-1">
            <RichEditor key={String(key)} initialHtml={value?.html ?? ''} onChange={setHtml} placeholder="Write the reply…" className="min-h-0 [&_.wren-editor]:min-h-32" />
          </div>
        </div>
      </div>
    </Modal>
  );
}
