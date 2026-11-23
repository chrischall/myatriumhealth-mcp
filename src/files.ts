// Handing a portal file back to the caller: an image as image content, a PDF
// as its text plus the file, anything else as the file — by the fleet's one
// delivery ladder (inline → signed link when hosted → a local file), so a big
// file never lands in the transcript and a hosted caller never gets a path it
// cannot open.

import { blobStoreFromEnv, deliverFile, sanitizeExportFileName, type DeliveredFile } from '@chrischall/mcp-utils/export';
import { extensionForMime, resolveOutputDir } from '@chrischall/mcp-utils';
import type { PortalFile } from './client.js';

/** Image types a model can actually look at. TIFF and BMP are not among them. */
const RENDERABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Largest image returned inline, in raw bytes. The Messages API refuses an
 * image over 5 MB, and base64 grows it by a third on the way.
 */
export const IMAGE_INLINE_MAX_BYTES = 3_750_000;

/** The local directory files are saved to: MAH_OUTPUT_DIR, else ~/Downloads/myatriumhealth-mcp. */
function localDir(): string {
  return resolveOutputDir(undefined, 'MAH_OUTPUT_DIR', { name: 'myatriumhealth-mcp' });
}

export function isRenderableImage(mimeType: string): boolean {
  return RENDERABLE.has(mimeType);
}

/** A safe file name with an extension that matches the bytes. */
export function fileNameFor(file: PortalFile, fallbackBase: string): string {
  const ext = extensionForMime(file.mimeType, { fallback: 'bin' });
  const base = file.fileName ?? fallbackBase;
  const named = /\.[A-Za-z0-9]{1,5}$/.test(base) ? base : `${base}.${ext}`;
  return sanitizeExportFileName(named);
}

/**
 * Deliver one file. Renderable images go inline when small enough; everything
 * else goes to a signed link (hosted) or a local file (0600), never inline as
 * an embedded resource most clients cannot open.
 */
export async function deliverPortalFile(file: PortalFile, fileName: string): Promise<DeliveredFile> {
  const image = isRenderableImage(file.mimeType);
  const hosted = blobStoreFromEnv() !== undefined;
  const needsDisk = !hosted && (!image || file.bytes.length > IMAGE_INLINE_MAX_BYTES);
  return deliverFile({
    bytes: file.bytes,
    fileName,
    mimeType: file.mimeType,
    prefer: image ? 'auto' : hosted ? 'link' : 'disk',
    inlineMaxBytes: image ? IMAGE_INLINE_MAX_BYTES : 0,
    keyPrefix: 'myatriumhealth',
    ...(needsDisk ? { disk: { dir: localDir(), mode: 0o600 } } : {}),
  });
}

