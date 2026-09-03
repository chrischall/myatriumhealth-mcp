import { z } from 'zod';
import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyAtriumHealthClient } from '../client.js';
import { project, tidy } from './_project.js';

export function registerResultTools(
  server: McpServer,
  client: MyAtriumHealthClient,
): void {
  server.registerTool(
    'mah_list_test_results',
    {
      description:
        'List lab and imaging results: name, abnormal flag, date, ordering provider and any provider comment. ' +
        'Individual result values load on the detail page and are not in this list.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        compact: z
          .boolean()
          .default(false)
          .describe('Project each result to its meaningful fields. The raw envelope is ~33 KB.'),
      },
    },
    async ({ compact }) => {
      const raw = await client.api('test-results/GetList');
      return jsonResult(
        project(raw, compact, 'test-results/GetList', (r: {
          // `newResults` is a MAP keyed by an opaque result handle, not an array.
          newResults?: Record<string, Record<string, unknown>>;
        }) =>
          r.newResults === undefined
            ? undefined
            : Object.values(r.newResults).map((v) => {
                const om = (v['orderMetadata'] ?? {}) as Record<string, unknown>;
                return tidy({
                  name: v['name'],
                  abnormal: v['isAbnormal'],
                  when: om['prioritizedInstantDisplay'],
                  whenIso: om['prioritizedInstantISO'],
                  provider: om['orderProviderName'],
                  resultType: om['resultType'],
                  comments: (v['providerComments'] as { content?: string }[] | undefined)?.map(
                    (c) => c.content,
                  ),
                });
              }),
        ),
      );
    },
  );
}
