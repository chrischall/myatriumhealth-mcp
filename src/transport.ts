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
}

export interface FetchResult {
  status: number;
  body: string;
  url?: string;
}

export interface MahTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  fetch(init: FetchInit): Promise<FetchResult>;
}
