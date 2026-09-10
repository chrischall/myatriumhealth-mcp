import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAdaptiveHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import { sessionClassifier, sessionProbe } from '@chrischall/mcp-utils/healthcheck';
import type { MyAtriumHealthAuth } from '../auth.js';
import { isAuthWall, type MyAtriumHealthClient } from '../client.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

const HOST = 'my.atriumhealth.org';

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
    hostLabel: HOST,
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
      // factory concatenates it onto hostLabel.
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
      // The status/redirect/auth-wall ladder and the three signed-out arms now
      // live in mcp-utils. What stays here is the part a library cannot write.
      probeFn: sessionProbe({
        // Deliberately `auth.request`, NOT the client or transport: those run
        // ensureSession(), so a healthcheck on a signed-out session would
        // silently submit credentials. A diagnostic must observe state, never
        // change it — and on an account whose login controller can switch on a
        // captcha, one that logs in is actively harmful.
        request: async () => {
          const { res, body } = await (auth as MyAtriumHealthAuth).request('Home');
          return { status: res.status, body };
        },
        // THE site-specific closure, and the readers' own test rather than a
        // second copy that could drift: it is title-scoped because every
        // signed-in page links to two-factor setup, so a body-wide match
        // reports "signed out" for every request.
        signedOut: isAuthWall,
        hostLabel: HOST,
      }),
      classifyThrown: sessionClassifier({
        hostLabel: HOST,
        // Named, never derived. The library used to build these from the tool
        // prefix, which happened to be right here and wrong everywhere else —
        // simplepractice signs in with simplepractice_request_sign_in_link,
        // kiaaccess with kia_start_login.
        remedies: {
          signIn: 'mah_sign_in',
          sendCode: 'mah_send_verification_code',
          verifyCode: 'mah_verify_code',
        },
        verificationPending: () => auth?.mfaPending === true,
        credentialsRejected: () => auth?.credentialsRejected === true,
        hints: {
          // The one default worth overriding: naming the two variables beats
          // "correct them", and this portal's escalation is worth stating.
          credential_rejected:
            `${HOST} refused this username and password. Check MAH_USERNAME and ` +
            'MAH_PASSWORD, then call mah_sign_in — nothing retries for you, because the ' +
            'portal counts failed sign-ins and escalates to a captcha.',
        },
      }),
    },
  });
}
