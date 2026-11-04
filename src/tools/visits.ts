import { z } from 'zod';
import { healthMeta } from './hints.js';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { isCompact, viewArg, viewResponse } from '../view.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { project, tidy } from './_project.js';
import { briefResult, briefUpcomingVisits, briefViewArg, isBrief } from '../brief.js';

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
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('whats-on', {
        canonical: true,
        aliases: ['appointments', 'appointment', 'doctor', 'checkup', 'visits'],
      }),
      inputSchema: z.object({
        view: briefViewArg('<visit type> — <ISO date or "no date"> — <in progress|upcoming>'),
        timeZone: z
          .string()
          .default('America/New_York')
          .describe('IANA time zone used to bucket appointments.'),
      }),
    },
    async ({ timeZone, view }) => {
      const served = await patients.readAs(client, async () => {
        return await client.legacy('Visits/VisitsList/LoadUpcoming', {
          timeZone,
          ComponentNumber: '5',
        }, {}, { retryOnTimeout: true });
      });
      if (isBrief(view)) return briefResult(briefUpcomingVisits(served.data));
      return viewResponse(view, served);
    },
  );

  server.registerTool(
    'mah_list_past_visits',
    {
      description:
        'List past MyAtriumHealth visits, grouped by organization. Compact output is ' +
        '{ items, complete, note }: complete is false when older visits exist, and the note ' +
        'says how to page back with before.',
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('lookup', { aliases: ['past visits', 'last appointment'] }),
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
