import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyAtriumHealthClient } from '../client.js';

export function registerAccountTools(
  server: McpServer,
  client: MyAtriumHealthClient,
): void {
  server.registerTool(
    'mah_get_health_summary',
    {
      description: 'Fetch the MyAtriumHealth health-summary header and action plans.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.api('health-summary/FetchHealthSummary')),
  );

  server.registerTool(
    'mah_list_message_folders',
    {
      description:
        'List Message Center folders with unread and total counts. ' +
        'Folder tags seen: 1 Conversations/inbox, 2 Archive, 3/6/7 Bookmarked, Appointments, Automated.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.api('conversations/GetFoldersList')),
  );

  server.registerTool(
    'mah_get_menu',
    {
      description:
        'List the features this MyAtriumHealth account exposes (the portal menu). ' +
        'Useful for discovering what is available before calling other tools.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => {
      const raw = (await client.api('search/LoadMenuInfo')) as {
        submenus?: { name?: string; menuItems?: { name?: string }[] }[];
      };
      return jsonResult(
        (raw.submenus ?? []).map((s) => ({
          menu: s.name,
          items: (s.menuItems ?? []).map((i) => i.name),
        })),
      );
    },
  );
}
