// Which URLs this server will fetch with the patient's session.
//
// Message bodies, letters and document metadata are written by other people,
// and anything they point at would be fetched as the signed-in patient. So a
// URL taken from them is followed only when it is the portal's OWN app path:
// https://my.atriumhealth.org/myatriumhealth/... — never another host, never
// another app on this host, never a data: or javascript: URI.

import { McpToolError } from '@chrischall/mcp-utils';

export const PORTAL_ORIGIN = 'https://my.atriumhealth.org';
const APP_PREFIX = '/myatriumhealth/';

function refuse(why: string): McpToolError {
  return new McpToolError(`Refusing to fetch that URL — only portal paths are followed, and ${why}.`, {
    hint:
      'Only the portal\'s own paths (https://my.atriumhealth.org/myatriumhealth/...) are fetched; ' +
      'links to anywhere else in message text are reported, never followed.',
  });
}

export interface PortalPathOptions {
  /**
   * Also accept a path with no leading slash, read as relative to the app
   * root. Only for values the portal's own JSON returns, never message HTML.
   */
  allowAppRelative?: boolean;
}

/**
 * Validate a URL or path and return it relative to the app root (no leading
 * slash, query kept) — the form every transport takes. Throws otherwise.
 */
export function portalPath(raw: string, opts: PortalPathOptions = {}): string {
  const s = raw.trim();
  if (s === '') throw refuse('it is empty');
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f]/.test(s)) throw refuse('it contains a backslash or control character');
  if (s.startsWith('//')) throw refuse('it is protocol-relative, so it names another host');
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (!hasScheme && !s.startsWith('/') && opts.allowAppRelative !== true) {
    throw refuse('it is not a portal path');
  }
  let url: URL;
  try {
    url = new URL(s, `${PORTAL_ORIGIN}${APP_PREFIX}`);
  } catch {
    throw refuse('it is not a valid URL');
  }
  if (url.origin !== PORTAL_ORIGIN || url.username !== '' || url.password !== '') {
    throw refuse('it is not on the portal');
  }
  // URL() has already resolved any ../, so this sees the real path.
  if (!url.pathname.toLowerCase().startsWith(APP_PREFIX)) {
    throw refuse('it is outside the portal app');
  }
  return `${url.pathname.slice(APP_PREFIX.length)}${url.search}`;
}

/** A file name as Image/Load takes it: a plain token (a GUID in practice). */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function isImageFileName(name: string): boolean {
  return FILE_NAME_RE.test(name) && !name.includes('..');
}

/** The app-relative path of an inline message image. */
export function imageLoadPath(fileName: string): string {
  if (!isImageFileName(fileName)) {
    throw new McpToolError('That is not an image file name the portal issues.', {
      hint: 'Pass the fileName from an [image N: fileName=...] placeholder in mah_get_message.',
    });
  }
  return `Image/Load?fileName=${encodeURIComponent(fileName)}`;
}

/** The fileName of an inline image src, or undefined when it is not a portal image. */
export function imageFileNameFromSrc(src: string): string | undefined {
  let path: string;
  try {
    path = portalPath(src);
  } catch {
    return undefined;
  }
  const url = new URL(path, `${PORTAL_ORIGIN}${APP_PREFIX}`);
  if (url.pathname.toLowerCase() !== `${APP_PREFIX}image/load`) return undefined;
  const name = url.searchParams.get('fileName') ?? '';
  return isImageFileName(name) ? name : undefined;
}
