// Types shared by the server and the web client.

export interface Addr {
  address: string;
  name?: string;
}

export type Role = 'owner' | 'admin' | 'user';
export type Folder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash';

/** Virtual mailbox views shown in the sidebar. */
export type View =
  | 'inbox'
  | 'starred'
  | 'snoozed'
  | 'important'
  | 'sent'
  | 'scheduled'
  | 'drafts'
  | 'all'
  | 'spam'
  | 'trash';

export interface VacationPrefs {
  enabled: boolean;
  subject: string;
  message: string;
  startAt: number | null;
  endAt: number | null;
  contactsOnly: boolean;
}

export interface ForwardingPrefs {
  enabled: boolean;
  to: string;
  /** What to do with the local copy after forwarding. */
  keep: 'inbox' | 'archive' | 'read' | 'trash';
}

export type SwipeAction = 'archive' | 'trash' | 'read' | 'none';

export interface UserPrefs {
  theme: 'system' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
  signature: string;
  /** Per-address signatures (From address → HTML); falls back to `signature`. */
  signatures: Record<string, string>;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  /** Show a notification for new mail while the app is open in a background tab. */
  notifications: boolean;
  signatureOnReplies: boolean;
  showImages: 'ask' | 'always';
  undoSendSeconds: number;
  pageSize: number;
  keyboardShortcuts: boolean;
  defaultFrom: string;
  readingPane: boolean;
  /** Split the inbox into Primary, Updates and Promotions. */
  inboxTabs: boolean;
  /** Email me when my account is signed in to from a new device. */
  signInAlerts: boolean;
  vacation: VacationPrefs;
  forwarding: ForwardingPrefs;
}

export const DEFAULT_PREFS: UserPrefs = {
  theme: 'system',
  density: 'comfortable',
  signature: '',
  signatures: {},
  swipeLeft: 'archive',
  swipeRight: 'read',
  notifications: false,
  signatureOnReplies: true,
  showImages: 'ask',
  undoSendSeconds: 5,
  pageSize: 50,
  keyboardShortcuts: true,
  defaultFrom: '',
  readingPane: false,
  inboxTabs: true,
  signInAlerts: true,
  vacation: { enabled: false, subject: '', message: '', startAt: null, endAt: null, contactsOnly: false },
  forwarding: { enabled: false, to: '', keep: 'inbox' },
};

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
  prefs: UserPrefs;
  identities: Identity[];
  mustSetup2fa: boolean;
}

export interface Identity {
  address: string;
  name: string;
  kind: 'mailbox' | 'alias' | 'group';
}

export interface Label {
  id: number;
  name: string;
  color: string;
  unread?: number;
  total?: number;
}

/** Inbox tab. */
export type Category = 'primary' | 'updates' | 'promotions';

export interface ThreadSummary {
  id: number;
  subject: string;
  snippet: string;
  participants: { name: string; address: string; unread: boolean; me: boolean }[];
  count: number;
  unread: boolean;
  starred: boolean;
  important: boolean;
  hasAttachments: boolean;
  date: number;
  labels: number[];
  folders: Folder[];
  hasDraft: boolean;
  status?: string;
  sendAt?: number | null;
  snoozedUntil?: number | null;
  /** The inbox tab of the latest message. */
  category?: Category;
  /** The alias or other address of the user's that the latest incoming message was sent to, when it isn't their main one. */
  via?: string | null;
}

export interface AttachmentInfo {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface MessageDetail {
  /** In a shared mailbox: the teammate who sent this message. */
  sentBy?: { name: string; email: string } | null;
  id: number;
  threadId: number;
  folder: Folder;
  direction: 'in' | 'out';
  messageId: string | null;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: string | null;
  subject: string;
  snippet: string;
  text: string | null;
  html: string | null;
  date: number;
  size: number;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  status: string;
  sendAt: number | null;
  lastError: string | null;
  labels: number[];
  attachments: AttachmentInfo[];
  spamScore: number | null;
  authResults: Record<string, string> | null;
  inReplyTo: string | null;
  references: string;
  identity: string | null;
  /** Incoming mail: the address of the user's it was delivered to (alias, group, catch-all…). */
  deliveredTo?: string | null;
  category?: Category;
  /** The sender offers an unsubscribe link or address (List-Unsubscribe). */
  canUnsubscribe?: boolean;
  /** The user already unsubscribed from this sender. */
  unsubscribed?: boolean;
}

export interface ThreadDetail {
  id: number;
  subject: string;
  messages: MessageDetail[];
}

export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  hasWords?: string;
  doesNotHave?: string;
  hasAttachment?: boolean;
}

export interface FilterActions {
  skipInbox?: boolean;
  markRead?: boolean;
  star?: boolean;
  important?: boolean;
  labelId?: number | null;
  forwardTo?: string;
  trash?: boolean;
  neverSpam?: boolean;
  alwaysSpam?: boolean;
}

export interface ProviderFieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'boolean' | 'textarea' | 'url';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
  /** Field relates to inbound webhooks only. */
  inbound?: boolean;
}

export interface ProviderTypeInfo {
  type: string;
  name: string;
  description: string;
  website: string;
  outbound: boolean;
  inbound: boolean;
  rawMime: boolean;
  fields: ProviderFieldDef[];
  spfInclude?: string;
  dkimSelectors?: string[];
  inboundSetup?: string;
  outboundSetup?: string;
  category: 'api' | 'smtp' | 'self-hosted' | 'inbound' | 'other';
  /** Shown first and marked as recommended. */
  recommended?: boolean;
  /** Receiving happens outside the provider (e.g. "Email Routing"). */
  inboundVia?: string;
  /** Quick-fill values (e.g. SMTP host presets). */
  presets?: { label: string; values: Record<string, string | number | boolean> }[];
}
