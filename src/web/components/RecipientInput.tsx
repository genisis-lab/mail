import { useEffect, useId, useRef, useState } from 'react';
import { Users, X } from 'lucide-react';
import type { Addr } from '../../shared/types';
import { api } from '../lib/api';
import { colorFor, initials } from '../lib/format';
import { cx } from './ui';

interface Suggestion {
  email: string;
  name: string;
  /** A contact group: picking it adds everyone in it. */
  members?: Addr[];
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Parse pasted/typed text like `Jane <jane@x.com>, bob@y.com` into addresses. */
export function parseAddrText(text: string): Addr[] {
  const out: Addr[] = [];
  const re = /(?:"?([^"<,;]*?)"?\s*<([^<>\s,;]+)>)|([^\s<>,;]+@[^\s<>,;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2]) out.push({ name: m[1].trim(), address: m[2].trim().toLowerCase() });
    else if (m[3]) out.push({ name: '', address: m[3].trim().toLowerCase() });
  }
  return out;
}

export function RecipientInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  label,
  trailing,
}: {
  value: Addr[];
  onChange: (v: Addr[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  label: string;
  trailing?: React.ReactNode;
}) {
  const listId = useId();
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 1) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ contacts: Suggestion[]; groups?: { id: number; name: string; members: { address: string; name: string }[] }[] }>(`/api/contacts?q=${encodeURIComponent(q)}`)
        .then((r) => {
          const taken = new Set(value.map((v) => v.address));
          const groups: Suggestion[] = (r.groups ?? []).map((g) => ({ email: `group:${g.id}`, name: g.name, members: g.members }));
          setSuggestions([...groups, ...r.contacts.filter((c) => !taken.has(c.email))].slice(0, 8));
          setActive(0);
        })
        .catch(() => setSuggestions([]));
    }, 120);
    return () => clearTimeout(t);
  }, [text, value]);

  const commit = (raw = text) => {
    const parsed = parseAddrText(raw);
    if (parsed.length) {
      const seen = new Set(value.map((v) => v.address));
      onChange([...value, ...parsed.filter((p) => !seen.has(p.address))]);
      setText('');
    } else if (raw.trim()) {
      // Keep invalid text as a (highlighted) chip so the user sees it.
      onChange([...value, { address: raw.trim(), name: '' }]);
      setText('');
    }
    setSuggestions([]);
  };

  const pick = (s: Suggestion) => {
    if (s.members) {
      const seen = new Set(value.map((v) => v.address.toLowerCase()));
      onChange([...value, ...s.members.filter((m) => !seen.has(m.address.toLowerCase()))]);
    } else onChange([...value, { address: s.email, name: s.name }]);
    setText('');
    setSuggestions([]);
    input.current?.focus();
  };

  return (
    <div className="relative flex min-h-10 items-start gap-2 border-b border-line px-1 py-1" onClick={() => input.current?.focus()}>
      <span className="shrink-0 pt-1.5 text-sm text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((a, i) => {
          const valid = EMAIL_RE.test(a.address);
          return (
            <span
              key={`${a.address}-${i}`}
              title={a.address}
              className={cx(
                'inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-0.5 text-[13px]',
                valid ? 'border-line-strong bg-panel' : 'border-danger bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-danger',
              )}
            >
              <span className="flex size-5 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: colorFor(a.address) }}>
                {initials(a.name || a.address)}
              </span>
              <span className="truncate">{a.name || a.address}</span>
              <button
                type="button"
                aria-label={`Remove ${a.address}`}
                className="rounded-full p-0.5 text-muted hover:bg-hover hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((_, j) => j !== i));
                }}
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={text}
          placeholder={value.length ? '' : placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setTimeout(() => commit(), 150);
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) commit(v.replace(/[,;]\s*$/, ''));
            else setText(v);
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (t.includes('@') && /[,;\n]/.test(t)) {
              e.preventDefault();
              commit(t);
            }
          }}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length && text) {
              e.preventDefault();
              pick(suggestions[active]);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
              if (e.key === 'Enter') e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            } else if (e.key === 'Escape') {
              setSuggestions([]);
            }
          }}
          aria-label={`${label} recipients`}
          aria-controls={listId}
          aria-activedescendant={focused && suggestions.length > 0 ? `${listId}-${active}` : undefined}
          role="combobox"
          aria-expanded={focused && suggestions.length > 0}
          aria-autocomplete="list"
          className="h-8 min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </div>
      {trailing}
      {focused && suggestions.length > 0 && (
        <div id={listId} role="listbox" aria-label="Suggestions" className="animate-pop absolute top-full left-10 z-30 mt-1 w-80 max-w-[calc(100vw-3rem)] overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-float">
          {suggestions.map((s, i) => (
            <button
              key={s.email}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cx('flex w-full items-center gap-3 px-3 py-2 text-left', i === active && 'bg-hover')}
            >
              {s.members ? (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                  <Users className="size-4" aria-hidden />
                </span>
              ) : (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: colorFor(s.email) }}>
                  {initials(s.name || s.email)}
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm">{s.name || s.email}</span>
                {s.members ? (
                  <span className="block truncate text-xs text-muted">
                    Group · {s.members.length === 1 ? '1 person' : `${s.members.length} people`}: {s.members.map((m) => m.name || m.address).join(', ')}
                  </span>
                ) : (
                  s.name && <span className="block truncate text-xs text-muted">{s.email}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
