import { z } from 'zod';
import { McpToolError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MfaRequiredError, type MyAtriumHealthAuth, type DeliveryMethod } from '../auth.js';

/**
 * Human-in-the-loop MFA. Nothing here bypasses the second factor: the portal
 * sends a code to the ACCOUNT HOLDER, and the code only enters the system when
 * they supply it. What gets stored afterwards is the portal's own
 * "remember this device" token.
 *
 * `auth` is undefined when no credentials are configured, i.e. when requests
 * relay through the browser bridge instead. These tools are STILL registered
 * then, and the reason is the hosted case: mcp-host collects this server's
 * credentials per connector user, so the principal-less child it spawns for
 * prewarm, auto-update, restart and every admin-portal tool listing has none —
 * and that child's tool list is what the portal publishes as the connector's
 * surface. Registering conditionally published a surface missing the three
 * tools the registration's own auth flow runs. A tool surface must describe the
 * SERVER, not the environment one process happened to start in.
 *
 * So the three that act refuse with the reason, and mah_auth_status answers
 * honestly: there is no server-side session because nothing is signing in.
 */
export function registerAuthTools(server: McpServer, auth: MyAtriumHealthAuth | undefined): void {
  /** The configured account, or a refusal that names what is missing. */
  const configured = (): MyAtriumHealthAuth => {
    if (auth !== undefined) return auth;
    throw new McpToolError(
      'This server is relaying through your signed-in my.atriumhealth.org browser tab, so ' +
        'there is nothing here to sign in to.',
      {
        hint:
          'Sign in to my.atriumhealth.org in the browser instead. To have this server sign ' +
          'in on its own — no tab, no extension — set MAH_USERNAME and MAH_PASSWORD and ' +
          'restart it; verification stays with the account holder either way.',
      },
    );
  };
  server.registerTool(
    'mah_auth_status',
    {
      description:
        'Report whether a stored session can be resumed, and whether a verification is ' +
        'pending. Session continuity comes from the persisted cookie jar.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => {
      if (auth === undefined) {
        // Not an error: "is there a stored session?" has a true answer here,
        // and it is no. Throwing would make a read-only status tool fail on a
        // correctly configured server.
        return minifiedResult({
          sessionResumable: false,
          verificationPending: false,
          trustedDeviceStored: false,
          nextStep:
            'This server holds no credentials and signs in to nothing — requests relay ' +
            'through your signed-in my.atriumhealth.org tab. Run mah_healthcheck to check ' +
            'that path.',
        });
      }
      const hasDevice = auth.deviceId() !== undefined;
      // isSignedIn() first: discovering a live session settles mfaPending, so
      // read the flag AFTER, or this reports a challenge that is already moot.
      const resumable = await auth.isSignedIn();
      return minifiedResult({
        sessionResumable: resumable,
        verificationPending: auth.mfaPending,
        trustedDeviceStored: hasDevice,
        nextStep: resumable
          ? 'A stored session is still live; no sign-in needed.'
          : 'Call mah_sign_in; a verification code may be required. The stored device ' +
            'token does NOT skip it — this portal will not redeem it.',
      });
    },
  );

  server.registerTool(
    'mah_sign_in',
    {
      description:
        'Sign in to MyAtriumHealth server-side. If the portal requires a verification ' +
        'code, this reports the available channels — ask the user which they want.',
      annotations: toolAnnotations({ readOnly: false }),
      inputSchema: {},
    },
    async () => {
      try {
        await configured().login();
        return minifiedResult({ signedIn: true });
      } catch (e) {
        if (e instanceof MfaRequiredError) {
          return minifiedResult({
            signedIn: false,
            verificationRequired: true,
            channels: e.methods,
            nextStep:
              'Ask the user which channel they want, call mah_send_verification_code, ' +
              'then pass the code THEY receive to mah_verify_code.',
          });
        }
        throw e;
      }
    },
  );

  server.registerTool(
    'mah_send_verification_code',
    {
      description:
        'Ask MyAtriumHealth to send a verification code to the account holder on the ' +
        'channel they chose. The code goes to them, not to this server.',
      annotations: toolAnnotations({ readOnly: false }),
      inputSchema: {
        channel: z
          .enum(['sms', 'email', 'totp'])
          .describe(
            'Channel the user chose, from the list mah_sign_in reported. ' +
            "'totp' is an authenticator app — nothing is sent; read the code from the app.",
          ),
        resend: z.boolean().default(false).describe('Set when re-sending after a code expired.'),
      },
    },
    async ({ channel, resend }) => {
      await configured().sendCode(channel as DeliveryMethod, resend);
      return minifiedResult({
        sent: true,
        channel,
        nextStep: 'Ask the user for the code they received, then call mah_verify_code.',
      });
    },
  );

  server.registerTool(
    'mah_verify_code',
    {
      description:
        'Submit the verification code the user received. On success the session is stored ' +
        'so restarts resume without signing in again, until it lapses.',
      annotations: toolAnnotations({ readOnly: false }),
      inputSchema: {
        code: z.string().min(4).describe('The code the USER received. Never guess or generate it.'),
        rememberDevice: z
          .boolean()
          .default(true)
          .describe(
            "Record the portal's device-trust token. NOTE: this portal does not redeem it, " +
            'so it does not skip future verification; the persisted session is what carries over.',
          ),
      },
    },
    async ({ code, rememberDevice }) => {
      const r = await configured().verifyCode(code, rememberDevice);
      return minifiedResult({
        verified: true,
        trustedDeviceStored: r.remembered,
        nextStep:
          'The session is stored, so restarts resume without signing in until it lapses. ' +
          'When it does, this same flow runs again — nothing needs reconnecting.',
      });
    },
  );
}
