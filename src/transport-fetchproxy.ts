// Adapter letting @fetchproxy/server satisfy MahTransport.
//
// Every MyChart cookie is HttpOnly and login is MFA-gated, so the session
// cannot be lifted out of the browser and replayed from Node. Requests run
// inside the user's own signed-in tab; this server never sees the cookie.
//
// The verb surface comes from the shared `createFetchproxyTransport` in
// @chrischall/mcp-utils/fetchproxy.

import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyVerbTransport,
} from '@chrischall/mcp-utils/fetchproxy';
import { McpToolError } from '@chrischall/mcp-utils';
import type { BinaryResult, FetchInit, FetchResult, MahTransport } from './transport.js';

/**
 * The whole fetchproxy fleet shares this concentrator port — the ContextMint
 * Bridge extension dials this one port and servers host/peer-elect on it. Picking a
 * "unique" port means the extension never connects.
 */
export const DEFAULT_PORT = 37_149;

/** MyChart is served under this path, not the host root. */
export const APP_ROOT = 'myatriumhealth';

export interface FetchproxyTransportOptions {
  port?: number;
  server?: string;
  version: string;
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements MahTransport {
  private readonly inner: FetchproxyVerbTransport;
  private readonly port: number;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: this.port,
      serverName: opts.server ?? 'myatriumhealth-mcp',
      version: opts.version,
      logListening: true,
      domains: ['atriumhealth.org'],
      defaultSubdomain: 'my',
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
    });
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  status(): ReturnType<FetchproxyVerbTransport['status']> {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    if (init.body !== undefined && typeof init.body !== 'string') {
      throw new McpToolError(
        'File uploads cannot go through the browser bridge — it relays a request body as ' +
          'text, and a binary upload would arrive corrupted.',
        {
          hint:
            'Send without attachments, or set MAH_USERNAME and MAH_PASSWORD so this server ' +
            'signs in itself; uploads work on that path.',
        },
      );
    }
    const response = await this.inner.fetch({
      method: init.method,
      path: `/${APP_ROOT}/${init.path.replace(/^\/+/, '')}`,
      ...(init.headers !== undefined ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.retryOnTimeout === true ? { retryOnTimeout: true } : {}),
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  /**
   * A file read through the bridge, intact (fetchproxy >= 3.5 binary fetch).
   * The extension runs it from its background worker with the browser's own
   * cookies for the portal, and refuses a final URL outside the declared
   * domain — so a redirect off the portal cannot be followed either.
   */
  async fetchBytes(init: FetchInit): Promise<BinaryResult> {
    if (init.body !== undefined && typeof init.body !== 'string') {
      throw new McpToolError('A binary request body cannot go through the browser bridge.', {
        hint: 'Set MAH_USERNAME and MAH_PASSWORD so this server signs in itself.',
      });
    }
    const r = await this.inner.server.requestBytes(
      init.method,
      `/${APP_ROOT}/${init.path.replace(/^\/+/, '')}`,
      {
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      },
    );
    const out: BinaryResult = { status: r.status, bytes: r.bytes, url: r.url };
    if (r.headers['content-type'] !== undefined) out.contentType = r.headers['content-type'];
    if (r.headers['content-disposition'] !== undefined) {
      out.contentDisposition = r.headers['content-disposition'];
    }
    return out;
  }

  async runProbe(
    fetchFn: (path: string) => Promise<string>,
    probePath: string,
  ): ReturnType<FetchproxyVerbTransport['runProbe']> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
