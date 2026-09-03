import { z } from 'zod';
import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyAtriumHealthClient } from '../client.js';
import { project, tidy } from './_project.js';

const compactArg = {
  compact: z
    .boolean()
    .default(false)
    .describe('Project each record to its clinically meaningful fields. Responses are large; prefer true for browsing.'),
};

export function registerRecordTools(
  server: McpServer,
  client: MyAtriumHealthClient,
): void {
  server.registerTool(
    'mah_list_allergies',
    {
      description: 'List allergies and their reactions from the MyAtriumHealth health summary.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: compactArg,
    },
    async ({ compact }) => {
      const raw = await client.api('allergies/LoadAllergies');
      return jsonResult(
        project(raw, compact, 'allergies/LoadAllergies', (r: {
          dataList?: { allergyItem?: Record<string, unknown> }[];
        }) =>
          r.dataList?.map((d) => {
            const a = (d.allergyItem ?? {}) as Record<string, unknown>;
            return tidy({
              name: a['name'],
              severe: a['isSevere'],
              classification: a['classification'],
              reactions: (a['reactionList'] as { name?: string }[] | undefined)?.map(
                (x) => x.name,
              ),
            });
          }),
        ),
      );
    },
  );

  server.registerTool(
    'mah_list_health_issues',
    {
      description: 'List the problem list (current health issues) recorded in MyAtriumHealth.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: compactArg,
    },
    async ({ compact }) => {
      const raw = await client.api('HealthIssues/LoadHealthIssuesData');
      return jsonResult(
        project(raw, compact, 'HealthIssues/LoadHealthIssuesData', (r: {
          dataList?: { healthIssueItem?: Record<string, unknown> }[];
        }) =>
          r.dataList?.map((d) => {
            const h = (d.healthIssueItem ?? {}) as Record<string, unknown>;
            return tidy({ name: h['name'], noted: h['formattedDateNoted'] });
          }),
        ),
      );
    },
  );

  server.registerTool(
    'mah_list_immunizations',
    {
      description: 'List immunizations and administration dates, grouped by organization.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: compactArg,
    },
    async ({ compact }) => {
      const raw = await client.api('immunizations/LoadImmunizations');
      return jsonResult(
        project(raw, compact, 'immunizations/LoadImmunizations', (r: {
          organizationImmunizationList?: {
            organization?: { OrganizationName?: string };
            orgImmunizations?: Record<string, unknown>[];
          }[];
        }) =>
          r.organizationImmunizationList?.flatMap((g) =>
            (g.orgImmunizations ?? []).map((i) =>
              tidy({
                name: i['name'],
                dates: i['formattedAdministeredDates'],
                organization: g.organization?.OrganizationName,
              }),
            ),
          ),
        ),
      );
    },
  );

  server.registerTool(
    'mah_list_medications',
    {
      description:
        'List current medications: name, patient-friendly name, dosing instructions (sig) and prescriber.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: compactArg,
    },
    async ({ compact }) => {
      const raw = await client.api('medications/LoadMedicationsPage');
      return jsonResult(
        project(raw, compact, 'medications/LoadMedicationsPage', (r: {
          communityMembers?: {
            prescriptionList?: { prescriptions?: Record<string, unknown>[] };
          }[];
        }) =>
          r.communityMembers?.flatMap((m) =>
            (m.prescriptionList?.prescriptions ?? []).map((p) =>
              tidy({
                name: p['name'],
                friendlyName: p['patientFriendlyName'],
                sig: p['sig'],
                prescriber: p['authorizingProvider'],
                date: p['dateToDisplay'],
                patientReported: p['isPatientReported'],
              }),
            ),
          ),
        ),
      );
    },
  );

  server.registerTool(
    'mah_list_goals',
    {
      description: 'List patient goals tracked in MyAtriumHealth.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: compactArg,
    },
    async ({ compact }) => {
      const raw = await client.api('goals/LoadPatientGoals');
      return jsonResult(
        project(raw, compact, 'goals/LoadPatientGoals', (r: {
          patientGoals?: Record<string, unknown>[];
        }) =>
          r.patientGoals?.map((g) =>
            tidy({
              goalId: g['goalId'],
              goalType: g['goalType'],
              lastUpdated: g['lastUpdatedDate'],
              created: g['creationDate'],
            }),
          ),
        ),
      );
    },
  );
}
