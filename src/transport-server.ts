// Bridge-less transport: talks to MyAtriumHealth directly with a server-side
// cookie jar, no browser involved. Selected when credentials are configured;
// otherwise the server falls back to the fetchproxy bridge.

import { McpToolError } from '@chrischall/mcp-utils';
import type { MyAtriumHealthAuth } from './auth.js';
import { BASE } from './auth.js';
import type { FetchInit, FetchResult, MahTransport } from './transport.js';

export class ServerTransport implements MahTransport {
  private loggedIn = false;
  /** Concurrent callers share one login — a burst must not spend N attempts. */
  private inFlight: Promise<void> | undefined;

  constructor(private readonly auth: MyAtriumHealthAuth) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  private async ensureSession(): Promise<void> {
    if (this.loggedIn) return;
    this.inFlight ??= (async () => {
      try {
        await this.auth.login();
        this.loggedIn = true;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    await this.ensureSession();
    const send = async (): Promise<FetchResult> => {
      const res = await this.auth.request(init.path, {
        method: init.method,
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      return { status: res.res.status, body: res.body, url: `${BASE}/${init.path}` };
    };

    let out = await send();
    // An expired session is a 200 whose body is the login page. Re-login once
    // and replay exactly once — never loop, because each attempt is a
    // credential submission and repeated failures escalate to a lockout.
    if (/<title>[^<]*Login Page/i.test(out.body)) {
      this.loggedIn = false;
      await this.ensureSession();
      out = await send();
      if (/<title>[^<]*Login Page/i.test(out.body)) {
        throw new McpToolError('MyAtriumHealth session could not be re-established.', {
          hint: 'Run mah_auth_status; a verification code may be required again.',
        });
      }
    }
    return out;
  }
}
