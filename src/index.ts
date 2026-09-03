#!/usr/bin/env node
// myatriumhealth-mcp — MyAtriumHealth (Atrium Health's Epic MyChart).
//
// Two transports, chosen by what is configured:
//
//   * credentials set  → bridge-less. Logs in server-side with a cookie jar.
//     No browser, no extension, and therefore hostable. MFA is human-in-the-loop:
//     the portal challenges, the USER picks a channel and supplies the code, and
//     the portal's own device-trust token is stored so later sign-ins skip it.
//   * otherwise        → the fetchproxy bridge, relaying through the user's
//     signed-in tab. Holds no credentials at all.
//
// Every data tool is read-only; only the sign-in tools mutate anything, and what
// they mutate is the local session.

import { runMcp, readEnvVar, readPortEnv } from '@chrischall/mcp-utils';
import { createFileStatePersistence, resolveStateFile } from '@chrischall/mcp-utils/session';
import { MyAtriumHealthAuth, type DeviceRecord } from './auth.js';
import { MyAtriumHealthClient } from './client.js';
import { ServerTransport } from './transport-server.js';
import { DEFAULT_PORT, FetchproxyTransport } from './transport-fetchproxy.js';
import type { MahTransport } from './transport.js';
import { registerAccountTools } from './tools/account.js';
import { registerAuthTools } from './tools/auth.js';
import { registerBillingTools } from './tools/billing.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerRecordTools } from './tools/records.js';
import { registerResultTools } from './tools/results.js';
import { registerVisitTools } from './tools/visits.js';
import { VERSION } from './version.js';

const username = readEnvVar('MAH_USERNAME');
const password = readEnvVar('MAH_PASSWORD');
const bridgeless = username !== undefined && password !== undefined;

const port = readPortEnv('MAH_WS_PORT', DEFAULT_PORT);
let transport: MahTransport;
let auth: MyAtriumHealthAuth | undefined;
let bridge: FetchproxyTransport | undefined;

if (bridgeless) {
  auth = new MyAtriumHealthAuth({
    credentials: () => ({ username, password }),
    persistence: createFileStatePersistence<DeviceRecord>({
      filePath: resolveStateFile({
        subdir: '.myatriumhealth-mcp',
        envVar: 'MAH_DEVICE_FILE',
        fileName: 'device.json',
      }),
      // Bind the device token to the account that earned it: swapping accounts
      // must not silently reuse the previous one's trust.
      boundTo: username,
      validate: (raw) => {
        const r = raw as Partial<DeviceRecord> | null;
        return r && typeof r.deviceId === 'string' && typeof r.username === 'string'
          ? (r as DeviceRecord)
          : null;
      },
    }),
  });
  transport = new ServerTransport(auth);
} else {
  bridge = new FetchproxyTransport({ port, version: VERSION });
  transport = bridge;
  await bridge.start();
}

const client = new MyAtriumHealthClient({ transport });

await runMcp({
  name: 'myatriumhealth-mcp',
  version: VERSION,
  banner: bridgeless
    ? `[myatriumhealth-mcp] v${VERSION} — bridge-less sign-in as the configured account. ` +
      'Verification codes go to the account holder; no browser required. ' +
      'This project was developed and is maintained by AI. Use at your own discretion.'
    : `[myatriumhealth-mcp] v${VERSION} — MyChart via @fetchproxy/server on 127.0.0.1:${port}. ` +
      'Requests are relayed through your signed-in my.atriumhealth.org tab; the session cookie is never read. ' +
      'This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [
    (server) => registerRecordTools(server, client),
    (server) => registerResultTools(server, client),
    (server) => registerVisitTools(server, client),
    (server) => registerAccountTools(server, client),
    (server) => registerBillingTools(server, client),
    ...(auth !== undefined ? [(server: Parameters<typeof registerAuthTools>[0]) => registerAuthTools(server, auth)] : []),
    ...(bridge !== undefined
      ? [(server: Parameters<typeof registerHealthcheckTools>[0]) => registerHealthcheckTools(server, client, bridge)]
      : []),
  ],
});
