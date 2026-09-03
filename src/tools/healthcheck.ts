import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
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
