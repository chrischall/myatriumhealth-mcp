import { McpToolError } from '@chrischall/mcp-utils';

/**
 * The portal answered with a sign-in or verification page, so it provably did
 * NOT act on the request. A distinct type because for a send that is the whole
 * question: "not accepted" is safe to retry, while any other failure after a
 * send was issued may mean it went through.
 */
export class NotAcceptedError extends McpToolError {
  constructor(message: string, opts: { hint: string }) {
    super(message, opts);
    this.name = 'NotAcceptedError';
  }
}

/** The transport surface the client needs — one method, so tests can fake it. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface FetchInit {
  method: HttpMethod;
  /** Path under the MyChart app root, e.g. `api/allergies/LoadAllergies`. */
  path: string;
  headers?: Record<string, string>;
  /**
   * A string for every JSON and form-encoded call. `FormData` only for a file
   * upload, which only the credential transport can carry: fetchproxy relays a
   * body as UTF-8 text, and binary multipart does not survive that.
   */
  body?: string | FormData;
  /**
   * `false` forbids the credential transport from signing in again and
   * replaying this request when the session turns out to have expired. For a
   * SEND: a fresh sign-in returns the portal to the account holder, so a replay
   * would post as whoever the new session serves, not the patient the send was
   * confirmed for. Default: replay once.
   */
  replay?: false;
  /**
   * `true` lets the browser bridge re-send this request after a transport
   * timeout. fetchproxy 3.2 re-sends only GET/HEAD/OPTIONS by default, and
   * every MyChart read is a POST — so a READ opts in here. Never set it on
   * anything that creates, changes or sends: a re-send could do it twice.
   */
  retryOnTimeout?: true;
}

export interface FetchResult {
  status: number;
  body: string;
  url?: string;
}

/**
 * A response read as BYTES — an inline image, an attachment, a document. The
 * text {@link FetchResult} cannot carry these: fetchproxy relays a text body as
 * UTF-8, and a PNG does not survive that.
 */
export interface BinaryResult {
  status: number;
  bytes: Uint8Array;
  /** The response `content-type`, when it carried one. */
  contentType?: string;
  /** The response `content-disposition`, for the file name. */
  contentDisposition?: string;
  /** A redirect target, when the transport does not follow redirects. */
  location?: string;
  url?: string;
}

/** A binary answer that is really an HTML page, decoded; otherwise undefined. */
export function binaryAsHtml(r: BinaryResult): string | undefined {
  const html =
    /text\/html/i.test(r.contentType ?? '') ||
    (r.contentType === undefined && r.bytes[0] === 0x3c); // '<'
  return html ? new TextDecoder().decode(r.bytes) : undefined;
}

export interface MahTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  fetch(init: FetchInit): Promise<FetchResult>;
  /**
   * The same request, answered as bytes. Optional so a test fake need not
   * implement it; the client refuses a file read on a transport without it.
   */
  fetchBytes?(init: FetchInit): Promise<BinaryResult>;
}
