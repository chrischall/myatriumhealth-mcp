import { z } from 'zod';
import {
  McpToolError,
  toolAnnotations,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  untrustedEnvelope,
} from '@chrischall/mcp-utils';
import { convertAttachment, convertedToContent } from '@chrischall/mcp-utils/convert';
import type { DeliveredFile } from '@chrischall/mcp-utils/export';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MyAtriumHealthClient, PortalFile } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { attachmentOf, findConversation, messagesOf } from '../conversation.js';
import { deliverPortalFile, fileNameFor, IMAGE_INLINE_MAX_BYTES, isRenderableImage } from '../files.js';
import { messageHtmlToText } from '../message-html.js';
import { healthMeta } from './hints.js';
import { tidy } from './_project.js';

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

/** Most images one mah_get_message call inlines, and their combined raw size. */
export const MAX_INLINE_IMAGES = 10;
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
/** Document Center pages read per call (25 documents each). */
const MAX_DOCUMENT_PAGES = 8;
const DOCUMENT_PAGE_SIZE = 25;
/** Most text returned for an HTML document; the file itself is always saved whole. */
const HTML_TEXT_MAX_CHARS = 60_000;

const NOTE = (who: string) => `${who} ${UNTRUSTED_CONTENT_RULE}`;
const MESSAGE_NOTE = NOTE(
  'Message text, image contents and attachments are written by clinic staff and automated senders.',
);

function result(payload: Record<string, unknown>, note: string, extra: Content[] = []): { content: Content[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(untrustedEnvelope(payload, { note })) }, ...extra],
  };
}

/** What a delivered file adds to the JSON beside its content blocks. */
function receipt(d: DeliveredFile): Record<string, unknown> {
  return tidy({
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    deliveredAs: d.via,
    path: d.path,
    url: d.url,
    expiresAt: d.expiresAt,
    note: d.note,
  });
}

/** A PDF's text layer as content blocks, or a note saying why there is none. */
async function pdfText(file: PortalFile, fileName: string): Promise<{ blocks: Content[]; note?: string }> {
  if (file.mimeType === 'text/html') {
    // Document Center keeps e-signed forms as HTML documents.
    const { text } = messageHtmlToText(new TextDecoder().decode(file.bytes));
    const cut = text.length > HTML_TEXT_MAX_CHARS;
    return {
      blocks: [{ type: 'text', text: `--- ${fileName} (text) ---\n${cut ? text.slice(0, HTML_TEXT_MAX_CHARS) : text}` }],
      ...(cut ? { note: `The document's text was cut at ${HTML_TEXT_MAX_CHARS} characters; the full file is saved.` } : {}),
    };
  }
  if (file.mimeType !== 'application/pdf') return { blocks: [] };
  try {
    const converted = await convertAttachment({ bytes: file.bytes, fileName, mimeType: file.mimeType, mode: 'text' });
    return converted === undefined ? { blocks: [] } : { blocks: convertedToContent(converted) as Content[] };
  } catch (e) {
    return { blocks: [], note: `The PDF's text could not be extracted (${(e as Error).message}); the file itself is delivered.` };
  }
}

/** Deliver a file plus, for a PDF, its text; the JSON says where the file went. */
async function fileResult(
  patient: string,
  file: PortalFile,
  fallbackName: string,
  extra: Record<string, unknown>,
): Promise<{ content: Content[] }> {
  const name = fileNameFor(file, fallbackName);
  const delivered = await deliverPortalFile(file, name);
  const text = await pdfText(file, name);
  const notes = [
    !isRenderableImage(file.mimeType) && file.mimeType.startsWith('image/')
      ? `${file.mimeType} is not an image type a model can view, so it was saved rather than shown.`
      : undefined,
    text.note,
  ].filter((n): n is string => n !== undefined);
  return result(
    { patient, ...extra, file: receipt(delivered), ...(notes.length > 0 ? { notes } : {}) },
    MESSAGE_NOTE,
    [...(delivered.content as Content[]), ...text.blocks],
  );
}

export interface FileToolOptions {
  /** MAH_READ_ONLY: refuse the one write here, marking a conversation read. */
  readOnly: boolean;
}

export function registerFileTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
  opts: FileToolOptions,
): void {
  server.registerTool(
    'mah_get_message',
    {
      description:
        'Read one Message Center conversation (a message from your doctor, nurse or clinic) as clean ' +
        'text: each message with its author, deliveryInstantISO, isUnread, the body as readable text, ' +
        'every inline image as a numbered placeholder ([image 3: fileName=...]) plus an images list ' +
        '(index, fileName, width, height, alt), and an attachments list (attachmentId, name, ' +
        'fileExtension). Use it whenever a message says "see below", "instructions attached" or shows ' +
        'pictures: view an image with mah_get_image, download an attachment with mah_download_attachment. ' +
        'includeImages: true also returns the images themselves (up to 10). Reading does not change ' +
        'the unread state; markRead: true marks the conversation read in the portal, and only then ' +
        '(refused under MAH_READ_ONLY). ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      _meta: healthMeta('lookup', {
        aliases: ['read message', 'open message', 'message from doctor', 'instructions', 'prep instructions'],
      }),
      inputSchema: z.object({
        conversationId: z.string().min(1).describe('The conversationId from mah_list_messages.'),
        messageId: z
          .string()
          .min(1)
          .optional()
          .describe('Only this message (messageId / lastMessageId). Omit for the whole thread.'),
        folder: z
          .number()
          .int()
          .optional()
          .describe('Folder tag the conversation is in, if known; otherwise every folder is searched.'),
        includeImages: z
          .boolean()
          .default(false)
          .describe(
            `Also return the inline images as image content (at most ${MAX_INLINE_IMAGES}, ` +
              `${MAX_INLINE_IMAGE_BYTES / 1024 / 1024} MiB together); the rest stay as placeholders.`,
          ),
        markRead: z
          .boolean()
          .default(false)
          .describe('Mark the conversation read in the portal, as opening it in the web app would. Default false.'),
      }),
    },
    async ({ conversationId, messageId, folder, includeImages, markRead }) => {
      const served = await patients.readAs(client, async () => {
        const raw = await findConversation(client, conversationId, folder);
        const messages = messagesOf(raw, messageId);
        const blocks: Content[] = [];
        const skipped: number[] = [];
        if (includeImages) {
          let total = 0;
          for (const m of messages) {
            for (const img of m.images ?? []) {
              if (img.fileName === undefined) continue;
              if (blocks.length >= MAX_INLINE_IMAGES) {
                skipped.push(img.index);
                continue;
              }
              const file = await client.image(img.fileName);
              if (!isRenderableImage(file.mimeType) || file.bytes.length > IMAGE_INLINE_MAX_BYTES ||
                  total + file.bytes.length > MAX_INLINE_IMAGE_BYTES) {
                skipped.push(img.index);
                continue;
              }
              total += file.bytes.length;
              blocks.push({ type: 'text', text: `[image ${img.index}]` });
              blocks.push({ type: 'image', data: Buffer.from(file.bytes).toString('base64'), mimeType: file.mimeType });
            }
          }
        }
        let marked: Record<string, unknown> | undefined;
        if (markRead) {
          if (opts.readOnly) {
            marked = { done: false, reason: 'MAH_READ_ONLY is set, so nothing in the portal is changed.' };
          // #150: BulkRead marks the whole conversation, so "already read" is judged on all of its messages,
          // not only the one a messageId narrowed the result to.
          } else if (!messagesOf(raw).some((m) => m.isUnread === true)) {
            marked = { done: true, note: 'Already read; nothing to change.' };
          } else {
            await client.markConversationsRead([
              {
                conversationId,
                organizationId:
                  typeof raw.conversation['organizationId'] === 'string'
                    ? (raw.conversation['organizationId'] as string)
                    : '',
              },
            ]);
            marked = { done: true };
          }
        }
        const participants = ((raw.conversation['userKeys'] as string[] | undefined) ?? [])
          .map((k) => raw.users[k]?.name)
          .filter((n): n is string => typeof n === 'string' && n !== '');
        return {
          conversation: tidy({
            conversationId,
            subject: raw.conversation['subject'],
            folder: raw.folder,
            participants: participants.length > 0 ? participants : undefined,
            moreMessagesInPortal: raw.conversation['hasMoreMessages'] === true ? true : undefined,
            messages,
            markRead: marked,
            imagesNotInlined: skipped.length > 0 ? skipped : undefined,
          }),
          blocks,
        };
      });
      return result({ patient: served.patient, ...served.data.conversation }, MESSAGE_NOTE, served.data.blocks);
    },
  );

  server.registerTool(
    'mah_get_image',
    {
      description:
        'View an inline image from a MyAtriumHealth message or letter — the pictures clinics embed ' +
        'in instructions (prep steps, diagrams, forms). Takes the fileName from an ' +
        '[image N: fileName=...] placeholder in mah_get_message or mah_get_document and returns the ' +
        'image itself, fetched through the signed-in session. Only the portal\'s own Image/Load path is ' +
        `fetched. Images over ${(IMAGE_INLINE_MAX_BYTES / 1_000_000).toFixed(2)} MB, or in a type a model ` +
        'cannot view (TIFF, BMP), are saved to a file (or a download link when hosted) instead. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('lookup', { aliases: ['message picture', 'show image', 'instructions image'] }),
      inputSchema: z.object({
        fileName: z.string().min(1).max(200).describe('The fileName from an [image N: fileName=...] placeholder.'),
      }),
    },
    async ({ fileName }) => {
      const served = await patients.readAs(client, () => client.image(fileName));
      return fileResult(served.patient, served.data, `image-${fileName.slice(0, 40)}`, { imageFileName: fileName });
    },
  );

  server.registerTool(
    'mah_download_attachment',
    {
      description:
        'Download a file attached to a Message Center message — a letter, form, clearance, scan or ' +
        'photo the clinic attached. Takes conversationId, messageId and attachmentId from ' +
        'mah_get_message. A viewable image comes back as image content; a PDF comes back as its text ' +
        'plus the file; anything else as the file. Files are saved under MAH_OUTPUT_DIR (default ' +
        '~/Downloads/myatriumhealth-mcp, mode 0600) on a local install, or as a short-lived download ' +
        'link when hosted. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('lookup', { aliases: ['attachment', 'download letter', 'attached file', 'clearance letter'] }),
      inputSchema: z.object({
        conversationId: z.string().min(1).describe('The conversationId from mah_list_messages / mah_get_message.'),
        messageId: z.string().min(1).describe('The messageId of the message carrying the attachment.'),
        attachmentId: z.string().min(1).describe('The attachmentId from that message\'s attachments.'),
        folder: z.number().int().optional().describe('Folder tag, if known; otherwise every folder is searched.'),
      }),
    },
    async ({ conversationId, messageId, attachmentId, folder }) => {
      const served = await patients.readAs(client, async () => {
        const raw = await findConversation(client, conversationId, folder);
        const att = attachmentOf(raw, messageId, attachmentId);
        const { file, details } = await client.documentFile({
          dcsId: att.dcsId,
          fileExtension: att.fileExtension,
          organizationId: att.organizationId,
          useOldMobileLink: false,
        });
        if (file.fileName === undefined) {
          const name = att.name ?? details.userFriendlyDisplayName ?? details.displayName;
          if (name !== undefined && name !== '') file.fileName = name;
        }
        return { file, name: att.name };
      });
      return fileResult(served.patient, served.data.file, 'attachment', tidy({ attachmentName: served.data.name }));
    },
  );

  server.registerTool(
    'mah_list_documents',
    {
      description:
        'List MyAtriumHealth portal documents — the "new document available" items: letters from ' +
        'your care team (Letters) and Document Center files (visit summaries, after-visit documents, ' +
        'forms, scanned records). Each letter carries letterId + csn and each document documentId + ' +
        'fileExtension for mah_get_document. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('whats-new', {
        aliases: ['documents', 'letters', 'new document', 'visit summary', 'after visit summary', 'records'],
      }),
      inputSchema: z.object({
        kind: z
          .enum(['all', 'letters', 'documents'])
          .default('all')
          .describe('letters (Letters), documents (Document Center), or all (both).'),
      }),
    },
    async ({ kind }) => {
      const served = await patients.readAs(client, async () => {
        const out: Record<string, unknown> = {};
        if (kind !== 'documents') out.letters = await section(() => listLetters(client));
        if (kind !== 'letters') out.documents = await section(() => listDocuments(client));
        return out;
      });
      return result({ patient: served.patient, ...served.data }, NOTE('Letter reasons and document names are written by clinic staff.'));
    },
  );

  server.registerTool(
    'mah_get_document',
    {
      description:
        'Open one MyAtriumHealth letter or Document Center document from mah_list_documents. A letter ' +
        '(letterId + csn) comes back as readable text with its inline images as [image N: fileName=...] ' +
        'placeholders for mah_get_image; a document (documentId + fileExtension) is downloaded — a PDF ' +
        'as its text plus the file, a viewable image as image content, anything else as a file ' +
        '(MAH_OUTPUT_DIR locally, a download link when hosted). Opening an unread letter marks it viewed ' +
        'in the portal, as the web app does (verified live); a document may be marked viewed too. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('lookup', { aliases: ['open letter', 'read document', 'visit summary', 'download document'] }),
      inputSchema: z.object({
        letterId: z.string().min(1).optional().describe('A letter\'s letterId from mah_list_documents (with csn).'),
        csn: z.string().optional().describe('The letter\'s csn from mah_list_documents.'),
        documentId: z.string().min(1).optional().describe('A document\'s documentId from mah_list_documents.'),
        fileExtension: z.string().optional().describe('The document\'s fileExtension from mah_list_documents.'),
      }),
    },
    async ({ letterId, csn, documentId, fileExtension }) => {
      if ((letterId === undefined) === (documentId === undefined)) {
        throw new McpToolError('Pass exactly one of letterId or documentId.', {
          hint: 'Both come from mah_list_documents: letters carry letterId + csn, documents documentId + fileExtension.',
        });
      }
      if (letterId !== undefined) {
        const served = await patients.readAs(client, () => client.letterDetails(letterId, csn ?? ''));
        const body = (served.data as { bodyHTML?: unknown }).bodyHTML;
        const { text, images } = messageHtmlToText(typeof body === 'string' ? body : '');
        return result(
          tidy({ patient: served.patient, letterId, text, images: images.length > 0 ? images : undefined }),
          NOTE('Letters are written by clinic staff.'),
        );
      }
      const served = await patients.readAs(client, async () => {
        const { file, details } = await client.documentFile({
          dcsId: documentId as string,
          fileExtension: fileExtension ?? '',
          useOldMobileLink: true,
        });
        if (file.fileName === undefined) {
          const name = details.userFriendlyDisplayName ?? details.displayName;
          if (name !== undefined && name !== '') file.fileName = name;
        }
        return file;
      });
      return fileResult(served.patient, served.data, 'document', { documentId });
    },
  );
}

/** Run one section of a combined listing; a section the portal refuses is reported, not fatal. */
async function section(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch (e) {
    // A sign-in wall is the whole call's problem, not one section's.
    if ((e as Error).name === 'NotAcceptedError' || (e as Error).name === 'MfaRequiredError') throw e;
    return { error: (e as Error).message };
  }
}

type Rec = Record<string, unknown>;

async function listLetters(client: MyAtriumHealthClient): Promise<unknown> {
  const raw = (await client.letters()) as {
    letters?: Rec[];
    users?: Record<string, { name?: string }>;
    departments?: Record<string, { name?: string }>;
  };
  return (raw.letters ?? []).map((l) => {
    const dep = typeof l['depId'] === 'string' && l['depId'] !== '' ? raw.departments?.[l['depId']]?.name : undefined;
    const emp = typeof l['empId'] === 'string' && l['empId'] !== '' ? raw.users?.[l['empId']]?.name : undefined;
    return tidy({
      letterId: l['hnoId'],
      csn: l['csn'],
      date: l['dateISO'],
      reason: l['reason'],
      from: dep ?? emp,
      unread: l['viewed'] === false ? true : undefined,
    });
  });
}

async function listDocuments(client: MyAtriumHealthClient): Promise<unknown> {
  const items: Rec[] = [];
  let complete = false;
  for (let page = 0; page < MAX_DOCUMENT_PAGES; page++) {
    const raw = (await client.otherDocuments(page === 0)) as { documents?: Rec[] };
    const docs = raw.documents ?? [];
    for (const d of docs) {
      const visit = (d['visit'] as Rec | undefined) ?? {};
      items.push(
        tidy({
          documentId: d['dcsID'] ?? d['dcsId'],
          fileExtension: typeof d['docExt'] === 'string' ? d['docExt'].toLowerCase() : undefined,
          type: d['docType'] ?? d['documentType'],
          description: d['docDesc'],
          date: d['date'] ?? d['formattedDate'],
          unread: d['new'] === true ? true : undefined,
          visitCsn: visit['csn'],
        }),
      );
    }
    if (docs.length < DOCUMENT_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  return complete
    ? items
    : { items, complete: false, note: `Only the newest ${items.length} documents were read; older ones are in the portal's Document Center.` };
}
