import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
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
        'Individual result values load on the detail page and are not in this list. Compact ' +
        'output is { items, complete, note }: complete is false when the portal loaded only ' +
        'part of the history.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        view: viewArg(),
      }),
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('test-results/GetList', {}, { retryOnTimeout: true });
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
              (r: { areResultsFullyLoaded?: unknown }) => {
                if (typeof r.areResultsFullyLoaded !== 'boolean') return {};
                return r.areResultsFullyLoaded
                  ? { complete: true }
                  : {
                      complete: false,
                      note:
                        'MyAtriumHealth loaded only part of the results history, so older results ' +
                        'exist that are not listed. This tool cannot page to them yet (the ' +
                        "portal's load-more request has not been captured); they are visible " +
                        'in the portal.',
                    };
              },
            );
        }),
      );
    },
  );
}
