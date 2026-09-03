import { z } from 'zod';
import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyAtriumHealthClient } from '../client.js';
import { project, tidy } from './_project.js';

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
    'mah_list_messages',
    {
      description:
        'List Message Center conversations for a folder. Folder tags come from ' +
        'mah_list_message_folders (1 = Conversations/inbox, 2 = Archive).',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        folder: z.number().int().default(1).describe('Folder tag, from mah_list_message_folders.'),
        compact: z
          .boolean()
          .default(false)
          .describe('Project to subject, preview, sender and date. The raw envelope is ~99 KB.'),
      },
    },
    async ({ folder, compact }) => {
      const raw = await client.listConversations(folder);
      return jsonResult(
        project(raw, compact, 'conversations/GetConversationList', (r: {
          conversations?: Record<string, unknown>[];
        }) =>
          r.conversations?.map((c) => {
            const msgs = (c['messages'] as Record<string, unknown>[] | undefined) ?? [];
            const first = msgs[0] ?? {};
            return tidy({
              subject: c['subject'],
              preview: c['previewText'],
              messageType: c['messageType'],
              date: first['deliveryInstantISO'],
              unread: msgs.some((m) => m['isUnread'] === true),
              hasAttachments: c['hasAttachments'],
              urgent: c['hasUrgentMsgs'],
              messageCount: msgs.length,
            });
          }),
        ),
      );
    },
  );

  server.registerTool(
    'mah_list_insurance',
    {
      description:
        'List insurance coverages on file: active, pending submission or deletion, ' +
        'in review, and in verification.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        compact: z
          .boolean()
          .default(false)
          .describe('Flatten every bucket to one row per coverage, tagged with its bucket.'),
      },
    },
    async ({ compact }) => {
      const raw = await client.legacy('Insurance/Coverages/GetCoverages', {}, {
        isStandAlone: 'true',
      });
      return jsonResult(
        project(raw, compact, 'Insurance/Coverages/GetCoverages', (r: Record<string, unknown>) => {
          const buckets = [
            'ActiveCoverages',
            'CoveragesPendingSubmission',
            'CoveragesPendingDeletion',
            'CoveragesInReview',
            'CoveragesInVerification',
          ] as const;
          if (!buckets.some((b) => Array.isArray(r[b]))) return undefined;
          return buckets.flatMap((b) =>
            ((r[b] as Record<string, unknown>[] | undefined) ?? []).map((c) =>
              tidy({
                bucket: b,
                coverage: c['CoverageName'],
                plan: c['PlanName'],
                payor: c['PayorName'],
                memberId: c['MemberId'],
                groupNumber: c['GroupNumber'],
                status: c['Status'],
                type: c['CoverageType'],
                effective: c['FormattedEffectiveDate'],
                ends: c['FormattedEndDate'],
                subscriber: c['SubscriberName'],
                patientIsSubscriber: c['PatientIsSubscriber'],
                termed: c['Termed'],
              }),
            ),
          );
        }),
      );
    },
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
