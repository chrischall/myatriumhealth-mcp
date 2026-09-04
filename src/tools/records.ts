import { z } from 'zod';
import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { project, tidy } from './_project.js';
import { isCompact, viewArg, viewResponse } from '../view.js';

export function registerRecordTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
): void {
  server.registerTool(
    'mah_list_allergies',
    {
      description: 'List allergies and their reactions from the MyAtriumHealth health summary.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: { view: viewArg() },
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('allergies/LoadAllergies');
          return project(raw, isCompact(view), 'allergies/LoadAllergies', (r: {
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
            );
        }),
      );
    },
  );

  server.registerTool(
    'mah_list_health_issues',
    {
      description: 'List the problem list (current health issues) recorded in MyAtriumHealth.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: { view: viewArg() },
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('HealthIssues/LoadHealthIssuesData');
          return project(raw, isCompact(view), 'HealthIssues/LoadHealthIssuesData', (r: {
              dataList?: { healthIssueItem?: Record<string, unknown> }[];
            }) =>
              r.dataList?.map((d) => {
                const h = (d.healthIssueItem ?? {}) as Record<string, unknown>;
                return tidy({ name: h['name'], noted: h['formattedDateNoted'] });
              }),
            );
        }),
      );
    },
  );

  server.registerTool(
    'mah_list_immunizations',
    {
      description: 'List immunizations and administration dates, grouped by organization.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: { view: viewArg() },
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('immunizations/LoadImmunizations');
          return project(raw, isCompact(view), 'immunizations/LoadImmunizations', (r: {
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
            );
        }),
      );
    },
  );

  server.registerTool(
    'mah_list_medications',
    {
      description:
        'List current medications: name, patient-friendly name, dosing instructions (sig) and prescriber.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: { view: viewArg() },
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('medications/LoadMedicationsPage');
          return project(raw, isCompact(view), 'medications/LoadMedicationsPage', (r: {
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
            );
        }),
      );
    },
  );

  server.registerTool(
    'mah_list_care_team',
    {
      description:
        'List care team providers — name, specialty and relationship — from this ' +
        'organization and from linked outside organizations.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: { view: viewArg() },
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.careTeam();
          return project(raw, isCompact(view), 'Clinical/CareTeam/Load', (r2: {
              internal?: { ProvidersList?: Record<string, unknown>[] };
              external?: { ProvidersList?: Record<string, unknown>[] };
            }) => {
              const lists = [r2.internal?.ProvidersList, r2.external?.ProvidersList];
              if (!lists.some(Array.isArray)) return undefined;
              const seen = new Set<string>();
              return lists
                .flatMap((l) => l ?? [])
                // Load and LoadExternal can surface the same provider; de-duplicate
                // on ID so the union does not double-count.
                .filter((p) => {
                  const id = String(p['ID'] ?? p['Name'] ?? '');
                  if (seen.has(id)) return false;
                  seen.add(id);
                  return true;
                })
                .map((p) =>
                  tidy({
                    name: p['Name'],
                    specialty: p['Specialty'],
                    relation: p['Relation'],
                    external: p['IsExternal'],
                    status: p['CareTeamStatus'],
                    npi: p['NationalProviderID'],
                    canMessage: p['CanMessage'],
                  }),
                );
            });
        }),
      );
    },
  );

  server.registerTool(
    'mah_list_goals',
    {
      description: 'List patient goals tracked in MyAtriumHealth.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: { view: viewArg() },
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('goals/LoadPatientGoals');
          return project(raw, isCompact(view), 'goals/LoadPatientGoals', (r: {
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
            );
        }),
      );
    },
  );
}
