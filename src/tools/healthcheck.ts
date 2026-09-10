import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAdaptiveHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import type { MyAtriumHealthAuth } from '../auth.js';
import { isAuthWall, type MyAtriumHealthClient } from '../client.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

/**
 * The probe reached my.atriumhealth.org and the portal declined to serve the
 * chart. Its own class so `classifyThrown` can tell it apart from a network
 * failure and name WHICH of the three signed-out states this account is in.
 */
class NotSignedInError extends Error {
  constructor(readonly detail: string) {
    super(`my.atriumhealth.org served a sign-in page rather than the chart (${detail}).`);
    this.name = 'NotSignedInError';
  }
}

/** A non-2xx from the portal, carrying the status the healthcheck reports. */
class ProbeHttpError extends Error {
  constructor(readonly status: number) {
    super(`my.atriumhealth.org answered ${status}.`);
    this.name = 'ProbeHttpError';
  }
}

export interface MahHealthcheckArms {
  /** Present when credentials are configured, i.e. when signing in server-side. */
  auth: MyAtriumHealthAuth | undefined;
  /** Present when relaying through the browser instead. */
  bridge: FetchproxyTransport | undefined;
}

/**
 * ONE `mah_healthcheck`, whichever transport this process ended up on.
 *
 * There were two registrations here, picked at boot: the bridge factory when
 * relaying, the credential factory when signing in server-side. Both register
 * the same tool NAME, so no client ever saw two healthchecks — but the tool's
 * title, description and result shape changed with the environment the process
 * started in. That surfaced as a wrong answer in the one place it matters:
 * mcp-host collects this server's credentials per connector user, so the
 * principal-less child behind the admin portal's tool listing starts without
 * them and published "Verify the fetchproxy bridge end-to-end" for a connector
 * that will never touch a bridge.
 *
 * The identity is fixed now and only the body varies. `usingBridge` is read per
 * call, so the answer describes the hop the caller is actually on.
 */
export function registerMahHealthcheckTool(
  server: McpServer,
  client: MyAtriumHealthClient,
  arms: MahHealthcheckArms,
): void {
  const { auth, bridge } = arms;
  registerAdaptiveHealthcheckTool({
    server,
    prefix: 'mah',
    hostLabel: 'my.atriumhealth.org',
    usingBridge: () => bridge !== undefined,
    bridge: {
      // The app root renders for a signed-in user and redirects to the login
      // page otherwise, so this probe distinguishes "bridge down" from
      // "signed out" — the two failures users actually hit.
      probePath: 'Home',
      // Only consulted on the bridge arm, which only runs when `bridge` is set.
      transport: () => bridge as unknown as NonNullable<typeof bridge>,
      probeFn: (path: string) => client.page(path),
    },
    credential: {
      // Leading slash + app root: this string is only for display, and the
      // factory concatenates it onto hostLabel — without them it renders as
      // 'my.atriumhealth.orgHome', which reads like a broken URL in a bug report.
      probePath: '/myatriumhealth/Home',
      // Report the SOURCE and non-secret facts only — never the password, the
      // device token, or any cookie. This is the output people paste into a chat
      // when something is broken.
      resolveCredential: async () => {
        if (auth === undefined) return { source: null };
        const resumable = await auth.isSignedIn();
        const detail: Record<string, unknown> = {
          sessionResumable: resumable,
          trustedDeviceStored: auth.deviceId() !== undefined,
          verificationPending: auth.mfaPending,
        };
        // A configured account with no live session is still "configured": the
        // remedy is a verification code, not new credentials. Saying `null` here
        // would send people to check MAH_USERNAME, which is not the problem.
        return { source: 'env', detail };
      },
      // Deliberately NOT routed through the client/transport: that would run
      // ensureSession(), so a healthcheck on a signed-out session would silently
      // submit credentials. A healthcheck must observe state, never change it —
      // and on an account whose login controller can switch on a captcha, a
      // diagnostic that logs in is actively harmful.
      //
      // But `request` is raw: it resolves for ANY answer the portal gives. This
      // portal answers a dead session with a login page served 200, or a 302 to
      // one — so "the fetch resolved" is not "the session works", and reading it
      // that way reported `ok: true` with "Credential from 'env' works" on an
      // account that could not load a single record. The probe has to judge the
      // response, using the SAME auth-wall test the readers use rather than a
      // second one that can drift from it.
      probeFn: async () => {
        const { res, body } = await (auth as MyAtriumHealthAuth).request('Home');
        // Manual redirects: a bounce to the login page arrives as a 3xx with no
        // body to match on, so status is the only signal here.
        if (res.status >= 300 && res.status < 400) {
          throw new NotSignedInError(`redirected with ${res.status}`);
        }
        if (!res.ok) throw new ProbeHttpError(res.status);
        if (isAuthWall(body)) throw new NotSignedInError('sign-in or verification page');
        return body;
      },
      // What makes the failure actionable. All three states below reach the
      // probe as the same login page, and they have three different remedies —
      // telling somebody with an outstanding code to check MAH_PASSWORD sends
      // them to change a credential that is already correct.
      classifyThrown: (err: unknown) => {
        if (err instanceof ProbeHttpError) {
          return {
            kind: 'http',
            hint:
              `my.atriumhealth.org answered ${err.status}. The credentials were never judged — ` +
              'this is a portal-side problem, so retry, and if it persists the portal is down.',
          };
        }
        if (!(err instanceof NotSignedInError)) return undefined;
        if (auth?.mfaPending === true) {
          return {
            kind: 'verification_pending',
            hint:
              'A verification code is outstanding, so the portal is holding the sign-in rather ' +
              'than refusing it. Call mah_send_verification_code, then pass the code the ' +
              'ACCOUNT HOLDER receives to mah_verify_code.',
          };
        }
        if (auth?.credentialsRejected === true) {
          return {
            kind: 'credential_rejected',
            hint:
              'my.atriumhealth.org refused this username and password. Check MAH_USERNAME and ' +
              'MAH_PASSWORD, then call mah_sign_in — nothing retries for you, because the ' +
              'portal counts failed sign-ins and escalates to a captcha.',
          };
        }
        return {
          kind: 'session_expired',
          hint:
            'The credentials are configured but no session is live — MyChart sessions are ' +
            'short-lived, so this recurs between uses. Call mah_sign_in; expect a verification ' +
            'code, which goes to the account holder.',
        };
      },
    },
  });
}
