import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAdaptiveHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import type { MyAtriumHealthAuth } from '../auth.js';
import type { MyAtriumHealthClient } from '../client.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

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
      probeFn: () => (auth as MyAtriumHealthAuth).request('Home'),
    },
  });
}
