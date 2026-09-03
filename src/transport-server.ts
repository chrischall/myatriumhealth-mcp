// Bridge-less transport: talks to MyAtriumHealth directly with a server-side
// cookie jar, no browser involved. Selected when credentials are configured;
// otherwise the server falls back to the fetchproxy bridge.

import { McpToolError } from '@chrischall/mcp-utils';
import type { MyAtriumHealthAuth } from './auth.js';
import { BASE, MfaRequiredError } from './auth.js';
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
    // Everything below shares ONE in-flight promise, including the cheap
    // is-it-already-live probe: a concurrent burst of tool calls otherwise
    // fires N GET Homes before converging on the single shared login.
    this.inFlight ??= (async () => {
      try {
        // A live session wins over either latch: both can be stale (verified in
        // another process, credentials since corrected, session restored from
        // disk), and checking them first would block calls that would succeed.
        if (await this.auth.isSignedIn()) {
          // isSignedIn() clears mfaPending itself — every caller that observes
          // a live session benefits, not just this one.
          this.loggedIn = true;
          return;
        }
        // The password was refused and nothing has changed since: report it
        // rather than spending another attempt. Six sequential tool calls must
        // not cost six failed logins — that is a lockout, and it would take the
        // bridge transport down too, since both share the account.
        if (this.auth.credentialsRejected) {
          throw new McpToolError('MyAtriumHealth did not accept the credentials.', {
            hint:
              'Fix MAH_USERNAME / MAH_PASSWORD, then call mah_sign_in to retry. Further ' +
              'tool calls will not re-attempt sign-in on their own, deliberately: repeated ' +
              'failures escalate to a captcha or lockout.',
          });
        }
        // Genuinely waiting on a code: surface that instead of logging in again.
        if (this.auth.mfaPending) {
          const ctx = await this.auth.challengeContext();
          throw new MfaRequiredError(ctx?.channels ?? ['sms', 'email'], {
            ...(ctx?.displayEmail !== undefined ? { email: ctx.displayEmail } : {}),
            ...(ctx?.displayPhone !== undefined ? { phone: ctx.displayPhone } : {}),
          });
        }
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
    // Write back any cookie the portal rotated during ordinary traffic.
    this.auth.persistIfDirty();
    // An expired session is a 200 whose body is the login page. Re-login once
    // and replay exactly once — never loop, because each attempt is a
    // credential submission and repeated failures escalate to a lockout.
    if (/<title>[^<]*Login Page/i.test(out.body)) {
      this.loggedIn = false;
      await this.ensureSession();
      out = await send();
      this.auth.persistIfDirty();
      if (/<title>[^<]*Login Page/i.test(out.body)) {
        throw new McpToolError('MyAtriumHealth session could not be re-established.', {
          hint: 'Run mah_auth_status; a verification code may be required again.',
        });
      }
    }
    return out;
  }
}
