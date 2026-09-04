import { z } from 'zod';
import { McpToolError, jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { project, tidy } from './_project.js';

export function registerAccountTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
): void {
  server.registerTool(
    'mah_get_health_summary',
    {
      description: 'Fetch the MyAtriumHealth health-summary header and action plans.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => {
      return jsonResult(
        await patients.readAs(client, async () => {
          return await client.api('health-summary/FetchHealthSummary');
        }),
      );
    },
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
    async () => {
      return jsonResult(
        await patients.readAs(client, async () => {
          return await client.api('conversations/GetFoldersList');
        }),
      );
    },
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
          .describe('Project to subject, participants, preview and date. The raw envelope is ~99 KB.'),
      },
    },
    async ({ folder, compact }) => {
      return jsonResult(
        await patients.readAs(client, async () => {
          const raw = await client.listConversations(folder);
          return project(raw, compact, 'conversations/GetConversationList', (r: {
              conversations?: Record<string, unknown>[];
              users?: Record<string, { name?: string }>;
            }) =>
              r.conversations?.map((c) => {
                const msgs = (c['messages'] as Record<string, unknown>[] | undefined) ?? [];
                const first = msgs[0] ?? {};
                // The per-message author is NOT resolvable: `author.displayName` is
                // empty on every conversation observed, and `author.wprKey` does not
                // match any key in the response's `users` map. The thread's
                // `userKeys` DO resolve, so participants are what can honestly be
                // reported here.
                const participants = ((c['userKeys'] as string[] | undefined) ?? [])
                  .map((k) => r.users?.[k]?.name)
                  .filter((n): n is string => typeof n === 'string' && n !== '');
                return tidy({
                  subject: c['subject'],
                  participants: participants.length > 0 ? participants : undefined,
                  preview: c['previewText'],
                  messageType: c['messageType'],
                  date: first['deliveryInstantISO'],
                  unread: msgs.some((m) => m['isUnread'] === true),
                  hasAttachments: c['hasAttachments'],
                  urgent: c['hasUrgentMsgs'],
                  messageCount: msgs.length,
                });
              }),
            );
        }),
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
      return jsonResult(
        await patients.readAs(client, async () => {
          const raw = await client.legacy('Insurance/Coverages/GetCoverages', {}, {
            isStandAlone: 'true',
          });
          return project(raw, compact, 'Insurance/Coverages/GetCoverages', (r: Record<string, unknown>) => {
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
            });
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
      return jsonResult(
        await patients.readAs(client, async () => {
          const raw = (await client.api('search/LoadMenuInfo')) as {
            submenus?: { name?: string; menuItems?: { name?: string }[] }[];
          };
          // This endpoint currently answers 302 to /Home/FiveHundred — a server
          // error, not an empty menu. Reported rather than flattened to []: an
          // empty feature list reads as "this account has no features", which is a
          // different and wrong answer. Cause not yet established.
          if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.submenus)) {
            throw new McpToolError('MyAtriumHealth did not return a menu.', {
              hint:
                'search/LoadMenuInfo is failing server-side (302 to Home/FiveHundred). Use ' +
                'mah_list_patients and the individual readers; the menu is not required for them.',
            });
          }
          return (raw.submenus ?? []).map((s) => ({
              menu: s.name,
              items: (s.menuItems ?? []).map((i) => i.name),
            }));
        }),
      );
    },
  );
}
