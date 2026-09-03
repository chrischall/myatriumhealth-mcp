import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { MyAtriumHealthAuth } from '../auth.js';
import type { MyAtriumHealthClient } from '../client.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

export function registerHealthcheckTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  transport: FetchproxyTransport,
): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'mah',
    // The app root renders for a signed-in user and redirects to the login
    // page otherwise, so this probe distinguishes "bridge down" from
    // "signed out" — the two failures users actually hit.
    probePath: 'Home',
    hostLabel: 'my.atriumhealth.org',
    transport,
    probeFn: (path) => client.page(path),
  });
}

/**
 * The bridge-less twin. Deliberately the CREDENTIAL factory, not the bridge one:
 * in this mode no request touches the browser bridge, so bridge health would be
 * reporting on something that is not on the request path.
 */
export function registerBridgelessHealthcheckTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  auth: MyAtriumHealthAuth,
): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'mah',
    hostLabel: 'my.atriumhealth.org',
    // Leading slash + app root: this string is only for display, and the
    // factory concatenates it onto hostLabel — without them it renders as
    // 'my.atriumhealth.orgHome', which reads like a broken URL in a bug report.
    probePath: '/myatriumhealth/Home',
    // Report the SOURCE and non-secret facts only — never the password, the
    // device token, or any cookie. This is the output people paste into a chat
    // when something is broken.
    resolveCredential: async () => {
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
    probeFn: () => client.page('Home'),
  });
}
