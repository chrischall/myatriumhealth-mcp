import { z } from 'zod';
import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MfaRequiredError, type MyAtriumHealthAuth, type DeliveryMethod } from '../auth.js';

/**
 * Human-in-the-loop MFA. Nothing here bypasses the second factor: the portal
 * sends a code to the ACCOUNT HOLDER, and the code only enters the system when
 * they supply it. What gets stored afterwards is the portal's own
 * "remember this device" token.
 */
export function registerAuthTools(server: McpServer, auth: MyAtriumHealthAuth): void {
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
      const hasDevice = auth.deviceId() !== undefined;
      // isSignedIn() first: discovering a live session settles mfaPending, so
      // read the flag AFTER, or this reports a challenge that is already moot.
      const resumable = await auth.isSignedIn();
      return jsonResult({
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
        await auth.login();
        return jsonResult({ signedIn: true });
      } catch (e) {
        if (e instanceof MfaRequiredError) {
          return jsonResult({
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
      await auth.sendCode(channel as DeliveryMethod, resend);
      return jsonResult({
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
      const r = await auth.verifyCode(code, rememberDevice);
      return jsonResult({
        verified: true,
        trustedDeviceStored: r.remembered,
        nextStep:
          'The session is stored, so restarts resume without signing in until it lapses. ' +
          'When it does, this same flow runs again — nothing needs reconnecting.',
      });
    },
  );
}
