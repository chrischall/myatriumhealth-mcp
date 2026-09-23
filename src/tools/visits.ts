import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { isCompact, viewArg, viewResponse } from '../view.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { project, tidy } from './_project.js';

/** Epic's visit endpoints are the older form-encoded generation. */
export function registerVisitTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
): void {
  server.registerTool(
    'mah_list_upcoming_visits',
    {
      description: 'List upcoming and in-progress MyAtriumHealth appointments.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        view: viewArg(),
        timeZone: z
          .string()
          .default('America/New_York')
          .describe('IANA time zone used to bucket appointments.'),
      }),
    },
    async ({ timeZone, view }) => {
      return viewResponse(
        view, await patients.readAs(client, async () => {
          const raw = await client.legacy('Visits/VisitsList/LoadUpcoming', {
            timeZone,
            ComponentNumber: '5',
          }, {}, { retryOnTimeout: true });
          return raw;
        }),
      );
    },
  );

  server.registerTool(
    'mah_list_past_visits',
    {
      description:
        'List past MyAtriumHealth visits, grouped by organization. Compact output is ' +
        '{ items, complete, note }: complete is false when older visits exist, and the note ' +
        'says how to page back with before.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        before: z
          .string()
          .optional()
          .describe('ISO instant to page back from. Defaults to now.'),
        view: viewArg(),
      }),
    },
    async ({ before, view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.legacy('Visits/VisitsList/LoadPast', {
            loadpast: '1',
            searchString: '',
            oldestRenderedDate: before ?? new Date().toISOString(),
            ComponentNumber: '7',
          }, {}, { retryOnTimeout: true });
          return project(raw, isCompact(view), 'Visits/VisitsList/LoadPast', (r: {
              List?: Record<
                string,
                { Organization?: { OrganizationName?: string }; List?: Record<string, unknown>[] }
              >;
            }) =>
              r.List === undefined
                ? undefined
                : Object.values(r.List).flatMap((g) =>
                    (g.List ?? []).map((v) =>
                      tidy({
                        organization: g.Organization?.OrganizationName,
                        date: v['PrimaryDate'],
                        bucket: v['PastVisitBucket'],
                        csn: v['Csn'],
                        unread: v['IsNotViewed'],
                      }),
                    ),
                  ),
              (r: {
                List?: Record<string, { Organization?: { OrganizationName?: string }; HasMoreData?: unknown }>;
              }) => {
                const groups = Object.values(r.List ?? {});
                const flags = groups.filter((g) => typeof g.HasMoreData === 'boolean');
                if (flags.length === 0) return {};
                const more = flags.filter((g) => g.HasMoreData === true);
                if (more.length === 0) return { complete: true };
                const where = more
                  .map((g) => g.Organization?.OrganizationName)
                  .filter((n): n is string => typeof n === 'string' && n !== '');
                return {
                  complete: false,
                  note:
                    `Older visits exist${where.length > 0 ? ` at ${where.join(', ')}` : ''}. ` +
                    'Call again with before set to an ISO instant earlier than the oldest visit ' +
                    'listed here to page back.',
                };
              },
            );
        }),
      );
    },
  );
}
