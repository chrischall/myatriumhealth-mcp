import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { project, tidy } from './_project.js';
import { isCompact, viewArg, viewResponse } from '../view.js';

export function registerResultTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
): void {
  server.registerTool(
    'mah_list_test_results',
    {
      description:
        'List lab and imaging results: name, abnormal flag, date, ordering provider and any provider comment. ' +
        'Individual result values load on the detail page and are not in this list.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        view: viewArg(),
      },
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('test-results/GetList');
          return project(raw, isCompact(view), 'test-results/GetList', (r: {
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
            );
        }),
      );
    },
  );
}
