import type { FilterActions, FilterCriteria } from '../../shared/types.js';
import { all } from '../db/index.js';
import type { Parsed } from './parse.js';

export interface FilterRow {
  id: number;
  name: string;
  criteria: FilterCriteria;
  actions: FilterActions;
}

export function userFilters(userId: number): FilterRow[] {
  return all<{ id: number; name: string; criteria: string; actions: string }>(
    'SELECT id, name, criteria, actions FROM filters WHERE user_id = ? AND enabled = 1 ORDER BY position, id',
    [userId],
  ).map((r) => ({ id: r.id, name: r.name, criteria: JSON.parse(r.criteria), actions: JSON.parse(r.actions) }));
}

function contains(haystack: string, needle: string | undefined): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  // Support "a OR b" and comma lists.
  return needle
    .split(/\s+OR\s+|,/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((n) => h.includes(n));
}

export interface MatchableMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  hasAttachment: boolean;
}

export function toMatchable(p: Parsed): MatchableMessage {
  return {
    from: p.from ? `${p.from.name ?? ''} <${p.from.address}>` : '',
    to: [...p.to, ...p.cc, ...p.deliveredTo.map((address) => ({ address, name: '' }))].map((a) => `${a.name ?? ''} <${a.address}>`).join(', '),
    subject: p.subject,
    body: `${p.text ?? ''} ${p.html ?? ''}`,
    hasAttachment: p.attachments.some((a) => !a.inline),
  };
}

export function matchesFilter(m: MatchableMessage, c: FilterCriteria): boolean {
  if (!c.from && !c.to && !c.subject && !c.hasWords && !c.doesNotHave && !c.hasAttachment) return false;
  if (!contains(m.from, c.from)) return false;
  if (!contains(m.to, c.to)) return false;
  if (!contains(m.subject, c.subject)) return false;
  if (c.hasWords && !contains(`${m.subject} ${m.body}`, c.hasWords)) return false;
  if (c.doesNotHave && contains(`${m.subject} ${m.body}`, c.doesNotHave)) return false;
  if (c.hasAttachment && !m.hasAttachment) return false;
  return true;
}

/** Merge the actions of every matching filter. */
export function applyFilters(userId: number, m: MatchableMessage): { actions: FilterActions; labelIds: number[]; forwardTo: string[] } {
  const merged: FilterActions = {};
  const labelIds: number[] = [];
  const forwardTo: string[] = [];
  for (const f of userFilters(userId)) {
    if (!matchesFilter(m, f.criteria)) continue;
    const a = f.actions;
    if (a.skipInbox) merged.skipInbox = true;
    if (a.markRead) merged.markRead = true;
    if (a.star) merged.star = true;
    if (a.important) merged.important = true;
    if (a.trash) merged.trash = true;
    if (a.neverSpam) merged.neverSpam = true;
    if (a.alwaysSpam) merged.alwaysSpam = true;
    if (a.labelId) labelIds.push(a.labelId);
    if (a.forwardTo) forwardTo.push(a.forwardTo);
  }
  return { actions: merged, labelIds, forwardTo };
}
