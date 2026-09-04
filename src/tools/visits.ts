import { z } from 'zod';
import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import { isCompact, viewArg, viewResponse } from '../view.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
      inputSchema: {
        view: viewArg(),
        timeZone: z
          .string()
          .default('America/New_York')
          .describe('IANA time zone used to bucket appointments.'),
      },
    },
    async ({ timeZone, view }) => {
      return viewResponse(
        view, await patients.readAs(client, async () => {
          const raw = await client.legacy('Visits/VisitsList/LoadUpcoming', {
            timeZone,
            ComponentNumber: '5',
          });
          return raw;
        }),
      );
    },
  );

  server.registerTool(
    'mah_list_past_visits',
    {
      description: 'List past MyAtriumHealth visits, grouped by organization.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        before: z
          .string()
          .optional()
          .describe('ISO instant to page back from. Defaults to now.'),
        view: viewArg(),
      },
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
          });
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
            );
        }),
      );
    },
  );
}
