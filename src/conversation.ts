// One Message Center conversation, read for the patient: its messages as text,
// their inline images and their attachments.
//
// The thread is read out of GetConversationList — the same read
// mah_list_messages makes — and NOT out of GetConversationDetails or
// GetConversationMessages. The web app marks a thread read only in its own
// state when it opens one, so which of those calls the portal treats as "the
// patient opened this" is not established; the list read is the one this
// server already makes on every mah_list_messages, so reading a message never
// changes its unread state. Marking read is a separate, explicit request
// (BulkConversationAction), made only when the caller asks for it.

import { McpToolError } from '@chrischall/mcp-utils';
import type { MyAtriumHealthClient } from './client.js';
import { messageHtmlToText, type MessageImage } from './message-html.js';
import { tidy } from './tools/_project.js';

type Rec = Record<string, unknown>;

export interface RawConversation {
  conversation: Rec;
  users: Record<string, { name?: string }>;
  viewers: Record<string, { name?: string; isSelf?: boolean }>;
  folder: number;
}

/** The kinds the app's attachment list knows (conversations bundle: ETX=1, DCS=2, DCS_HNO=3). */
const ATTACHMENT_KIND: Record<number, string> = { 1: 'text', 2: 'document', 3: 'document' };

/**
 * Find a conversation by its id. Searches the folder given, or else the inbox
 * first and then every other folder that holds anything.
 */
export async function findConversation(
  client: MyAtriumHealthClient,
  conversationId: string,
  folder?: number,
): Promise<RawConversation> {
  let tags: number[];
  if (folder !== undefined) {
    tags = [folder];
  } else {
    const f = await client.api<{ folders?: { tag?: number; totalCount?: number }[] }>(
      'conversations/GetFoldersList',
      {},
      { retryOnTimeout: true },
    );
    const others = (f.folders ?? [])
      .filter((x) => typeof x.tag === 'number' && x.tag !== 1 && (x.totalCount ?? 1) > 0)
      .map((x) => x.tag as number);
    tags = [1, ...others];
  }
  for (const tag of tags) {
    const list = (await client.listConversations(tag)) as {
      conversations?: Rec[];
      users?: RawConversation['users'];
      viewers?: RawConversation['viewers'];
    };
    const conversation = list.conversations?.find((c) => c['hthId'] === conversationId);
    if (conversation !== undefined) {
      return { conversation, users: list.users ?? {}, viewers: list.viewers ?? {}, folder: tag };
    }
  }
  throw new McpToolError(
    `No conversation with that id in ${folder !== undefined ? `folder ${folder}` : 'any message folder'}.`,
    { hint: 'Take the conversationId from mah_list_messages (it is the thread id, not a message id).' },
  );
}

export interface AttachmentRef {
  attachmentId: string;
  name?: string;
  fileExtension?: string;
  kind?: string;
  /** False for a kind mah_download_attachment cannot fetch. */
  downloadable: boolean;
}

export interface MessageView {
  messageId?: string;
  author?: string;
  deliveryInstantISO?: string;
  isUnread?: boolean;
  text: string;
  images?: MessageImage[];
  attachments?: AttachmentRef[];
}

function attachmentsOf(m: Rec): AttachmentRef[] {
  const raw = (m['attachments'] as Rec[] | undefined) ?? [];
  return raw.map((a) => {
    const type = typeof a['type'] === 'number' ? (a['type'] as number) : undefined;
    const dcsId = typeof a['dcsId'] === 'string' ? a['dcsId'] : '';
    const etxId = typeof a['etxId'] === 'string' ? a['etxId'] : '';
    const ref: AttachmentRef = {
      attachmentId: dcsId !== '' ? dcsId : etxId,
      downloadable: dcsId !== '',
    };
    if (typeof a['name'] === 'string' && a['name'] !== '') ref.name = a['name'];
    if (typeof a['fileExtension'] === 'string' && a['fileExtension'] !== '') {
      ref.fileExtension = a['fileExtension'].toLowerCase();
    }
    if (type !== undefined && ATTACHMENT_KIND[type] !== undefined) ref.kind = ATTACHMENT_KIND[type];
    return ref;
  });
}

/**
 * Who wrote a message. Staff resolve through `author.empKey` against `users`
 * (renamed by the thread's `userOverrideNames` where it has one); the patient's
 * own messages carry `author.wprKey` instead, which names a viewer.
 */
function authorOf(m: Rec, raw: RawConversation): string | undefined {
  const a = (m['author'] as Rec | undefined) ?? {};
  const display = typeof a['displayName'] === 'string' ? a['displayName'].trim() : '';
  if (display !== '') return display;
  const overrides = (raw.conversation['userOverrideNames'] as Record<string, unknown> | undefined) ?? {};
  const emp = typeof a['empKey'] === 'string' ? a['empKey'] : '';
  if (emp !== '') {
    const o = overrides[emp];
    if (typeof o === 'string' && o !== '') return o;
    const name = raw.users[emp]?.name;
    if (name !== undefined && name !== '') return name;
  }
  const wpr = typeof a['wprKey'] === 'string' ? a['wprKey'] : '';
  if (wpr !== '') {
    const viewer = raw.viewers[wpr];
    if (viewer?.name !== undefined && viewer.name !== '') return viewer.name;
    return 'the patient (MyChart account)';
  }
  return undefined;
}

export function messagesOf(raw: RawConversation, messageId?: string): MessageView[] {
  const all = (raw.conversation['messages'] as Rec[] | undefined) ?? [];
  const picked = messageId === undefined ? all : all.filter((m) => m['wmgId'] === messageId);
  if (messageId !== undefined && picked.length === 0) {
    throw new McpToolError('That message is not in this conversation.', {
      hint: 'Omit messageId to read the whole thread; each message carries its messageId.',
    });
  }
  return picked.map((m) => {
    const { text, images } = messageHtmlToText(typeof m['body'] === 'string' ? m['body'] : '');
    const attachments = attachmentsOf(m);
    return tidy({
      messageId: m['wmgId'] as string | undefined,
      author: authorOf(m, raw),
      deliveryInstantISO: m['deliveryInstantISO'] as string | undefined,
      isUnread: m['isUnread'] as boolean | undefined,
      text,
      images: images.length > 0 ? images : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    }) as MessageView;
  });
}

/** Find one attachment of one message, with what its download needs. */
export function attachmentOf(
  raw: RawConversation,
  messageId: string,
  attachmentId: string,
): { dcsId: string; fileExtension: string; name?: string; organizationId: string } {
  const m = ((raw.conversation['messages'] as Rec[] | undefined) ?? []).find((x) => x['wmgId'] === messageId);
  if (m === undefined) {
    throw new McpToolError('That message is not in this conversation.', {
      hint: 'Take conversationId, messageId and attachmentId from mah_get_message.',
    });
  }
  const a = ((m['attachments'] as Rec[] | undefined) ?? []).find(
    (x) => x['dcsId'] === attachmentId || x['etxId'] === attachmentId,
  );
  if (a === undefined) {
    throw new McpToolError('That attachment is not on this message.', {
      hint: 'Take the attachmentId from the message\'s attachments in mah_get_message.',
    });
  }
  const dcsId = typeof a['dcsId'] === 'string' ? a['dcsId'] : '';
  if (dcsId === '') {
    throw new McpToolError('This attachment is a portal text item, not a downloadable file.', {
      hint: 'Open the message in the portal to see it.',
    });
  }
  const out: { dcsId: string; fileExtension: string; name?: string; organizationId: string } = {
    dcsId,
    fileExtension: typeof a['fileExtension'] === 'string' ? a['fileExtension'] : '',
    organizationId:
      typeof a['organizationId'] === 'string'
        ? a['organizationId']
        : typeof raw.conversation['organizationId'] === 'string'
          ? (raw.conversation['organizationId'] as string)
          : '',
  };
  if (typeof a['name'] === 'string' && a['name'] !== '') out.name = a['name'];
  return out;
}

/**
 * mah_list_messages' "full" rung, minus the message bodies. One Epic body can
 * be tens of KB of styled HTML, and a folder's worth made a single list call
 * 122 KB on one line. Every other field is kept as the portal sent it; each
 * body is replaced by its size and a pointer to mah_get_message.
 */
export function omitBodies(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const r = raw as { conversations?: Rec[] };
  if (!Array.isArray(r.conversations)) return raw;
  return {
    ...r,
    conversations: r.conversations.map((c) => ({
      ...c,
      messages: ((c['messages'] as Rec[] | undefined) ?? []).map((m) => {
        const { body, ...rest } = m;
        return typeof body === 'string' ? { ...rest, bodyOmitted: { chars: body.length } } : rest;
      }),
    })),
    bodiesOmitted:
      'Message bodies are not part of a list. Read one with mah_get_message(conversationId), ' +
      'which returns it as text with its images and attachments.',
  };
}
