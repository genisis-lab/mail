/** Read contacts from Google/Outlook/Apple CSV exports and vCard (.vcf) files. */
import { csvRecords, pick } from './csv';

export interface ContactInput {
  email: string;
  name: string;
  phone: string;
  company: string;
  notes: string;
}

const clip = (s: string, n: number) => s.trim().slice(0, n);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function make(emails: string[], fields: Omit<ContactInput, 'email'>): ContactInput[] {
  return emails
    .map((e) => e.trim().replace(/^mailto:/i, ''))
    .filter((e) => EMAIL.test(e))
    .map((email) => ({ email, name: clip(fields.name, 100), phone: clip(fields.phone, 50), company: clip(fields.company, 100), notes: clip(fields.notes, 5000) }));
}

export function contactsFromCsv(text: string): ContactInput[] {
  const { records } = csvRecords(text);
  const out: ContactInput[] = [];
  for (const r of records) {
    const name =
      pick(r, 'name', 'fullname', 'displayname') ||
      [pick(r, 'firstname', 'givenname'), pick(r, 'middlename', 'additionalname'), pick(r, 'lastname', 'familyname', 'surname')].filter(Boolean).join(' ');
    // Google puts several addresses in one cell, separated by " ::: ".
    const emails = ['email', 'emailaddress', 'email1value', 'email2value', 'email3value', 'email2address', 'email3address', 'emailaddress2', 'emailaddress3']
      .map((k) => r[k] ?? '')
      .flatMap((v) => v.split(/\s*:::\s*|[;,]\s*/))
      .filter(Boolean);
    out.push(
      ...make([...new Set(emails)], {
        name,
        phone: pick(r, 'phone', 'phone1value', 'mobilephone', 'primaryphone', 'businessphone', 'homephone').split(/\s*:::\s*/)[0] ?? '',
        company: pick(r, 'company', 'organizationname', 'organization1name', 'organization'),
        notes: pick(r, 'notes', 'note'),
      }),
    );
  }
  return out;
}

const unescapeVcard = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

export function contactsFromVcard(text: string): ContactInput[] {
  // Unfold continuation lines (RFC 6350 §3.2).
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: ContactInput[] = [];
  let card: { fn: string; n: string; emails: string[]; tel: string; org: string; note: string } | null = null;
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const prop = head.split(';')[0].replace(/^item\d+\./i, '').toUpperCase();
    if (prop === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') card = { fn: '', n: '', emails: [], tel: '', org: '', note: '' };
    else if (!card) continue;
    else if (prop === 'END') {
      const n = card.n.split(';').map(unescapeVcard);
      const name = card.fn || [n[1], n[2], n[0]].filter(Boolean).join(' ');
      out.push(...make(card.emails, { name, phone: card.tel, company: card.org, notes: card.note }));
      card = null;
    } else if (prop === 'FN') card.fn = unescapeVcard(value);
    else if (prop === 'N') card.n = value;
    else if (prop === 'EMAIL') card.emails.push(unescapeVcard(value));
    else if (prop === 'TEL' && !card.tel) card.tel = unescapeVcard(value).replace(/^tel:/i, '');
    else if (prop === 'ORG' && !card.org) card.org = unescapeVcard(value.split(/(?<!\\);/)[0]);
    else if (prop === 'NOTE') card.note = unescapeVcard(value);
  }
  return out;
}

export function contactsFromFile(name: string, text: string): ContactInput[] {
  return /\.vcf$|\.vcard$/i.test(name) || /^\s*BEGIN:VCARD/i.test(text) ? contactsFromVcard(text) : contactsFromCsv(text);
}
