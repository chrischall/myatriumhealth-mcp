// Getting a caller's file into a reply when the caller shares no filesystem
// with this server — the hosted (mcp-host) case.
//
// Two ways in, by size:
//
//  - **Upload slots** (hosted, the main path). mah_upload_slots mints a signed
//    PUT URL per file on mcp-host's per-registration blob store; the caller
//    `curl`s each file to it, then names it to mah_reply_message by blobKey.
//    No base64 in the tool call, so no ~9.9 MiB request ceiling, and no model
//    emitting a phone photo as text.
//  - **Inline base64** (`attachments`). Works anywhere, but every byte rides
//    inside one JSON-RPC request. Decoded STRICTLY: Buffer.from silently drops
//    characters it does not recognise, so a truncated payload would otherwise
//    reach the care team as a corrupt file.
//
// The shared rules (key shape, filename, strict base64, slot signing) are the
// fleet's, from @chrischall/mcp-utils/export. What is local is the portal's
// own list of accepted file types and the wording that names these tools.

import { McpToolError } from '@chrischall/mcp-utils';
import {
  blobStoreFromEnv,
  MAX_UPLOAD_FILES,
  mintUploadSlot,
  sanitizeUploadFilename,
  uploadFileNameFromKey,
  type BlobStore,
  type UploadSlot,
  type UploadSlotRequest,
} from '@chrischall/mcp-utils/export';

/** Media types for the extensions the portal accepts (GetComposeSettings, live). */
export const MIME: Record<string, string> = {
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

/** The upper-cased extension of a filename, or '' when it has none. */
export const extensionOf = (filename: string): string => /\.([^.]+)$/.exec(filename)?.[1]?.toUpperCase() ?? '';

/** Run a shared helper, turning its plain Error into this server's tool error. */
export function asToolError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof McpToolError) throw e;
    throw new McpToolError((e as Error).message);
  }
}

/** Why a reply through the browser bridge can carry no file at all. */
export const BRIDGE_REASON =
  'Attachments need the credential transport: this server relays through the browser ' +
  'bridge, which cannot carry a file upload.';

/** The blob store, or a refusal that says what to use instead. */
export function requireBlobStore(what: string): BlobStore {
  const store = blobStoreFromEnv();
  if (store) return store;
  throw new McpToolError(
    `${what} needs the blob store an mcp-host deployment provides, and this server has none ` +
      '(it is a local install). Pass the file to mah_reply_message as attachments (base64) instead.',
  );
}

/**
 * The filename a blobKey was minted for. Only the exact shape a slot mints is
 * accepted, so blobKeys can never be aimed at another object in this
 * registration's store and passed off as the caller's upload.
 */
export function fileNameFromBlobKey(key: string): string {
  try {
    return uploadFileNameFromKey(key);
  } catch {
    // The shared message names no tool; this one names the tool that mints keys.
    throw new McpToolError(
      `blobKey ${JSON.stringify(key)} is not an upload key. Pass each blobKey exactly as mah_upload_slots returned it.`,
    );
  }
}

const SLOTS_NEXT =
  'Nothing has been sent. PUT each file to its uploadUrl with the slot\'s Content-Type (each slot\'s ' +
  'curl does exactly that — replace the @\'<path …>\' with the file), then call mah_reply_message with ' +
  'blobKeys (in this order). The URLs stop working at expiresAt. A file is deleted from the upload ' +
  'store once the reply carrying it is sent; until then it can be reused.';

/**
 * Mint one signed PUT slot per requested file. Touches nothing on the portal:
 * the portal's per-reply limits (count, size) are read live and applied when
 * mah_reply_message reads the files back. Refused up front: a file type the
 * portal never accepts, a bad filename, more than {@link MAX_UPLOAD_FILES}
 * files, no blob store, or a transport that cannot upload at all.
 */
export function mintReplySlots(
  files: UploadSlotRequest[],
  opts: { attachmentsSupported: boolean },
): { slots: UploadSlot[]; blobKeys: string[]; next: string } {
  if (!opts.attachmentsSupported) {
    throw new McpToolError(BRIDGE_REASON, {
      hint: 'Set MAH_USERNAME and MAH_PASSWORD so the server signs in itself.',
    });
  }
  if (files.length > MAX_UPLOAD_FILES) {
    throw new McpToolError(`At most ${MAX_UPLOAD_FILES} upload slots per call (asked for ${files.length}).`);
  }
  // Every name is checked before anything is signed, so a bad entry mints nothing.
  const checked = files.map((f) => {
    const filename = asToolError(() => sanitizeUploadFilename(f.filename));
    const ext = extensionOf(filename);
    const mimeType = MIME[ext];
    if (mimeType === undefined) {
      throw new McpToolError(`MyAtriumHealth does not accept ${ext || 'extension-less'} files (${filename}).`, {
        hint: `Accepted: ${Object.keys(MIME).join(', ')}.`,
      });
    }
    return { filename, mimeType: f.mimeType ?? mimeType };
  });
  const store = requireBlobStore('mah_upload_slots');
  const slots = checked.map((req) => asToolError(() => mintUploadSlot(store, req)));
  return { slots, blobKeys: slots.map((s) => s.blobKey), next: SLOTS_NEXT };
}

/** What happened to the uploaded copies once the reply carrying them was sent. */
export interface UploadStoreReport {
  deleted: string[];
  notDeleted?: { filename: string; error: string }[];
}

/**
 * Delete each blob a SENT reply carried. Never throws: the reply has gone
 * out, so a failed delete is reported (the store's retention prune reclaims
 * the object), not raised as a failure that would invite a resend.
 */
export async function releaseBlobs(
  store: BlobStore,
  files: { filename: string; blobKey: string }[],
): Promise<UploadStoreReport> {
  const deleted: string[] = [];
  const notDeleted: { filename: string; error: string }[] = [];
  for (const f of files) {
    try {
      await store.delete(f.blobKey);
      deleted.push(f.filename);
    } catch (e) {
      notDeleted.push({ filename: f.filename, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return notDeleted.length > 0 ? { deleted, notDeleted } : { deleted };
}
