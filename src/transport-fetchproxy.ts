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
import type { FetchInit, FetchResult, MahTransport } from './transport.js';

/**
 * The whole fetchproxy fleet shares this concentrator port — the Transporter
 * extension dials this one port and servers host/peer-elect on it. Picking a
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
    const response = await this.inner.fetch({
      method: init.method,
      path: `/${APP_ROOT}/${init.path.replace(/^\/+/, '')}`,
      ...(init.headers !== undefined ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  async runProbe(
    fetchFn: (path: string) => Promise<string>,
    probePath: string,
  ): ReturnType<FetchproxyVerbTransport['runProbe']> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
