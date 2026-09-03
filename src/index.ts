#!/usr/bin/env node
// myatriumhealth-mcp — MyAtriumHealth (Atrium Health's Epic MyChart) over the
// fetchproxy browser bridge.
//
// Boot order:
//   1. Construct the transport on the shared concentrator port (37149 unless
//      MAH_WS_PORT overrides — the override is what makes hosting possible,
//      because the runner injects a per-registration port).
//   2. Start the bridge BEFORE runMcp connects stdio, so the extension can
//      pair while the host is still waiting on the handshake.
//   3. runMcp registers the tools and prints the stderr banner.
//
// Every tool is read-only: this surface exposes no writes, so nothing here is
// confirm-gated.

import { runMcp, readPortEnv } from '@chrischall/mcp-utils';
import { MyAtriumHealthClient } from './client.js';
import { DEFAULT_PORT, FetchproxyTransport } from './transport-fetchproxy.js';
import { registerAccountTools } from './tools/account.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerRecordTools } from './tools/records.js';
import { registerResultTools } from './tools/results.js';
import { registerVisitTools } from './tools/visits.js';
import { VERSION } from './version.js';

const port = readPortEnv('MAH_WS_PORT', DEFAULT_PORT);
const transport = new FetchproxyTransport({ port, version: VERSION });
const client = new MyAtriumHealthClient({ transport });

await transport.start();

await runMcp({
  name: 'myatriumhealth-mcp',
  version: VERSION,
  banner:
    `[myatriumhealth-mcp] v${VERSION} — MyChart via @fetchproxy/server on 127.0.0.1:${port}. ` +
    'Requests are relayed through your signed-in my.atriumhealth.org tab; the session cookie is never read. ' +
    'This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [
    (server) => registerRecordTools(server, client),
    (server) => registerResultTools(server, client),
    (server) => registerVisitTools(server, client),
    (server) => registerAccountTools(server, client),
    (server) => registerHealthcheckTools(server, client, transport),
  ],
});
