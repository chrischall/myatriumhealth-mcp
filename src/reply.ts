// Replying to a Message Center conversation.
//
// Every request here replays what the MyChart web app itself sends when you
// press Reply and then Send — captured live on 2026-09-21 and written up in
// docs/MYATRIUMHEALTH-API.md ("Replying to a conversation"). Nothing is
// inferred: where the app's behaviour was not observed, this refuses rather
// than guessing, because the one thing a send must never do is go out wrong.

import { McpToolError } from '@chrischall/mcp-utils';
import { parse } from 'node-html-parser';
import type { MyAtriumHealthClient } from './client.js';
import type { PatientContext } from './patient-context.js';
import { NotAcceptedError } from './transport.js';

export interface ReplyAttachment {
  filename: string;
  contentBase64: string;
}

export interface ReplyInput {
  conversationId: string;
  body: string;
  attachments?: ReplyAttachment[];
  confirm?: boolean;
}

export interface ReplyOptions {
  /** MAH_READ_ONLY: previews still work; sends are refused. */
  readOnly: boolean;
  /** Only the credential transport can carry a binary upload. */
  attachmentsSupported: boolean;
}

interface Message {
  wmgId?: string;
  isUnread?: boolean;
  deliveryInstantISO?: string;
  body?: string;
  author?: { wprKey?: string };
  attachments?: unknown[];
}

interface Details {
  hthId?: string;
  subject?: string;
  organizationId?: string;
  replyFlags?: { canReply?: boolean; cannotReplyReason?: number };
  viewers?: Record<string, { wprId?: string; isSelf?: boolean }>;
  userKeys?: string[];
  users?: Record<string, { name?: string }>;
  messages?: Message[];
}

interface ComposeSettings {
  maxMessageLength?: number;
  attachmentSettings?: {
    canAttach?: boolean;
    maxNumberOfAttachments?: number;
    docAndImageSettings?: { maxFileSize?: number; allowedFileExtensions?: string[] };
    videoSettings?: { maxFileSize?: number; allowedFileExtensions?: string[] };
  };
}

/** Media types for the extensions the portal accepts. */
const MIME: Record<string, string> = {
  BMP: 'image/bmp',
  DOC: 'application/msword',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  JPEG: 'image/jpeg',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
  PNG: 'image/png',
  TIF: 'image/tiff',
  TIFF: 'image/tiff',
  '3GP': 'video/3gpp',
  '3GPP': 'video/3gpp',
  AVI: 'video/x-msvideo',
  MOV: 'video/quicktime',
  MP4: 'video/mp4',
  MPEG: 'video/mpeg',
  MPG: 'video/mpeg',
  WMV: 'video/x-ms-wmv',
};

/** The composer's own split: every line break starts a new paragraph. */
export function toParagraphs(body: string): string[] {
  return body.split(/\r\n|[\r\n]/);
}

/** The paragraphs of a stored message body, which comes back as HTML. */
export function paragraphsOf(html: string): string[] {
  const root = parse(html);
  for (const s of root.querySelectorAll('style')) s.remove();
  return root.querySelectorAll('[data-paragraph]').map((p) => p.text);
}

const sameText = (a: string[], b: string[]): boolean => {
  const norm = (x: string[]): string => x.join('\n').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
};

interface PreparedFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Decode and check every attachment against the portal's own limits. */
function prepareAttachments(files: ReplyAttachment[], settings: ComposeSettings): PreparedFile[] {
  if (files.length === 0) return [];
  const a = settings.attachmentSettings ?? {};
  if (a.canAttach !== true) {
    throw new McpToolError('MyAtriumHealth does not allow attachments on this reply.');
  }
  const max = a.maxNumberOfAttachments ?? 0;
  if (files.length > max) {
    throw new McpToolError(`MyAtriumHealth allows at most ${max} attachments per message.`);
  }
  return files.map((f) => {
    const ext = /\.([^.]+)$/.exec(f.filename)?.[1]?.toUpperCase() ?? '';
    const kind = a.docAndImageSettings?.allowedFileExtensions?.includes(ext)
      ? a.docAndImageSettings
      : a.videoSettings?.allowedFileExtensions?.includes(ext)
        ? a.videoSettings
        : undefined;
    if (kind === undefined || MIME[ext] === undefined) {
      const allowed = [
        ...(a.docAndImageSettings?.allowedFileExtensions ?? []),
        ...(a.videoSettings?.allowedFileExtensions ?? []),
      ];
      throw new McpToolError(`MyAtriumHealth does not accept ${ext || 'extension-less'} files (${f.filename}).`, {
        hint: `Accepted: ${allowed.join(', ')}.`,
      });
    }
    if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(f.contentBase64)) {
      throw new McpToolError(`${f.filename}: contentBase64 is not valid base64.`);
    }
    const bytes = new Uint8Array(Buffer.from(f.contentBase64, 'base64'));
    if (bytes.length === 0) throw new McpToolError(`${f.filename} is empty.`);
    // The portal states its limits in KB.
    const limit = (kind.maxFileSize ?? 0) * 1024;
    if (bytes.length > limit) {
      throw new McpToolError(
        `${f.filename} is too large: ${bytes.length} bytes, over the portal limit of ${kind.maxFileSize} KB.`,
      );
    }
    return { filename: f.filename, mimeType: MIME[ext] as string, bytes };
  });
}

/** Everything the send needs, established before anything is sent. */
async function prepare(client: MyAtriumHealthClient, input: ReplyInput) {
  const details = (await client.conversationDetails(input.conversationId)) as Details;
  if (details?.hthId !== input.conversationId) {
    throw new McpToolError(`No conversation ${input.conversationId} for the current patient.`, {
      hint:
        'conversationId is the conversationId from mah_list_messages. Threads belong to one ' +
        'patient — check mah_get_patient_context.',
    });
  }
  if (details.replyFlags?.canReply !== true) {
    throw new McpToolError(
      `This conversation cannot be replied to (portal reason code ${details.replyFlags?.cannotReplyReason ?? 'unknown'}).`,
      { hint: 'Start a new message in the portal instead.' },
    );
  }
  // The reply is attributed to the viewer the portal marks as self — what the
  // app sends. With none, or more than one, whose reply this is is not
  // something this tool will guess.
  const selves = Object.values(details.viewers ?? {}).filter((v) => v.isSelf === true && v.wprId);
  if (selves.length !== 1) {
    throw new McpToolError(
      `Expected exactly one viewer marked as you on this conversation, found ${selves.length}.`,
      { hint: 'Reply in the portal instead; this case has not been observed.' },
    );
  }
  const organizationId = details.organizationId ?? '';
  const settings = (await client.api('conversations/GetComposeSettings', {
    organizationId,
  })) as ComposeSettings;

  if (input.body.trim() === '') throw new McpToolError('The reply body is empty.');
  const maxLen = settings.maxMessageLength ?? 0;
  if (input.body.length > maxLen) {
    throw new McpToolError(
      `The reply is ${input.body.length} characters; MyAtriumHealth allows ${maxLen}.`,
      { hint: 'Shorten it, or split it across more than one reply.' },
    );
  }
  const files = prepareAttachments(input.attachments ?? [], settings);
  const recipients = (details.userKeys ?? [])
    .map((k) => details.users?.[k]?.name)
    .filter((n): n is string => typeof n === 'string' && n !== '');
  return {
    details,
    organizationId,
    selfWprId: selves[0]!.wprId as string,
    paragraphs: toParagraphs(input.body),
    files,
    recipients,
  };
}

/** The portal accepted the reply but it could not be read back. */
const UNCERTAIN_HINT =
  'Check the thread with mah_list_messages before retrying — sending again may post it twice.';

export async function replyToConversation(
  client: MyAtriumHealthClient,
  patients: PatientContext,
  input: ReplyInput,
  opts: ReplyOptions,
): Promise<Record<string, unknown>> {
  return patients.writeAs(client, async ({ patient, assertUnchanged }) => {
    const p = await prepare(client, input);
    const summary = {
      patient,
      conversationId: input.conversationId,
      subject: p.details.subject,
      recipients: p.recipients,
      body: input.body,
      attachments: p.files.map((f) => ({ filename: f.filename, bytes: f.bytes.length })),
    };
    const readOnlyReason =
      'MAH_READ_ONLY is set on this server, so replies are refused. Unset it (or set it to ' +
      'false) and restart to allow sending.';
    const bridgeReason =
      'Attachments need the credential transport: this server relays through the browser ' +
      'bridge, which cannot carry a file upload.';
    const blocked = opts.readOnly
      ? readOnlyReason
      : p.files.length > 0 && !opts.attachmentsSupported
        ? bridgeReason
        : undefined;

    if (input.confirm !== true) {
      return {
        sent: false,
        ...summary,
        ...(blocked !== undefined ? { sendBlocked: blocked } : {}),
        nextStep:
          'Nothing was sent. Show this to the user; if they approve, call mah_reply_message ' +
          'again with the same arguments and confirm: true. Sending is irreversible.',
      };
    }
    if (opts.readOnly) throw new McpToolError(readOnlyReason);
    if (p.files.length > 0 && !opts.attachmentsSupported) {
      throw new McpToolError(bridgeReason, {
        hint: 'Send without attachments, or set MAH_USERNAME and MAH_PASSWORD so the server signs in itself.',
      });
    }

    assertUnchanged();
    const composeId = await client.api<string>('conversations/GetComposeId', {});
    const uploaded: Awaited<ReturnType<MyAtriumHealthClient['uploadDocument']>>[] = [];
    const cleanUp = async (): Promise<void> => {
      for (const d of uploaded) await client.deleteDocument(d, p.organizationId).catch(() => {});
      await client.api('conversations/RemoveComposeId', { composeId }).catch(() => {});
    };

    const payload = () => ({
      conversationId: input.conversationId,
      organizationId: p.organizationId,
      viewers: [{ wprId: p.selfWprId }],
      messageBody: p.paragraphs,
      documentIds: uploaded.map((d) => d.documentId),
      includeOtherViewers: false,
      composeId,
    });

    // Everything up to SendReply is recoverable, so any failure here cleans up
    // after itself and reports that nothing was sent.
    try {
      assertUnchanged();
      for (const f of p.files) uploaded.push(await client.uploadDocument(f, p.organizationId));
      assertUnchanged();
      const draft = await client.api<{ conversationId?: string; error?: number }>(
        'conversations/SaveReplyDraft',
        payload(),
      );
      if (draft?.conversationId !== input.conversationId || draft.error !== 0) {
        throw new McpToolError('MyAtriumHealth refused the reply draft, so nothing was sent.', {
          hint: `The portal answered ${JSON.stringify(draft).slice(0, 120)}.`,
        });
      }
      assertUnchanged();
    } catch (e) {
      await cleanUp();
      throw e;
    }

    let answer: unknown;
    try {
      answer = await client.api('conversations/SendReply', payload(), { replay: false });
    } catch (e) {
      if (e instanceof NotAcceptedError) {
        await cleanUp();
        throw e;
      }
      throw new McpToolError(
        `The reply may have been sent — the portal's answer could not be read (${(e as Error).message}).`,
        { hint: UNCERTAIN_HINT },
      );
    }
    // The app treats the thread id coming back as success. Anything else is not
    // a refusal we can vouch for either, so it is reported as uncertain and the
    // uploads are left alone: they may now belong to a sent message.
    if (answer !== input.conversationId) {
      throw new McpToolError('MyAtriumHealth did not confirm the reply; it may have been sent.', {
        hint: UNCERTAIN_HINT,
      });
    }
    await client.api('conversations/RemoveComposeId', { composeId }).catch(() => {});

    // SendReply returns only the thread id, so the new message is found by
    // reading the thread back: new since the send began, written by this
    // viewer, with the text that was sent.
    const seen = new Set((p.details.messages ?? []).map((m) => m.wmgId));
    let message: Message | undefined;
    try {
      const after = (await client.conversationDetails(input.conversationId, p.organizationId)) as Details;
      message = (after.messages ?? [])
        .filter(
          (m) =>
            !seen.has(m.wmgId) &&
            m.author?.wprKey === p.selfWprId &&
            sameText(paragraphsOf(m.body ?? ''), p.paragraphs),
        )
        .at(-1);
    } catch {
      message = undefined;
    }
    return {
      sent: true,
      verified: message !== undefined,
      ...summary,
      ...(message !== undefined
        ? {
            message: {
              wmgId: message.wmgId,
              deliveryInstantISO: message.deliveryInstantISO,
              isUnread: message.isUnread,
              attachments: message.attachments ?? [],
            },
          }
        : {
            note:
              'MyAtriumHealth confirmed the send, but the new message could not be read back ' +
              'from the thread. Check it with mah_list_messages; do not resend.',
          }),
    };
  });
}
