import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult, toolAnnotations, McpToolError } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { listPatients, whoAmI } from '../patients.js';

export function registerPatientTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
): void {
  server.registerTool(
    'mah_list_patients',
    {
      description:
        'List the patients this login can open: the account holder plus anyone who has ' +
        'granted proxy access (a child, for example). Use the returned id with ' +
        'mah_set_active_patient.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => jsonResult(await listPatients(client)),
  );

  server.registerTool(
    'mah_get_patient_context',
    {
      description:
        'Which patient the reading tools are currently returning data for. Confirmed ' +
        'with the portal rather than reported from memory.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => {
      const serving = await whoAmI(client);
      return jsonResult({
        servingNow: serving.displayName,
        age: serving.age,
        isDefault: patients.isDefault(),
        note: patients.isDefault()
          ? 'No patient selected, so reads return the account holder.'
          : 'A patient is selected; it is re-applied automatically after any re-sign-in.',
      });
    },
  );

  server.registerTool(
    'mah_set_active_patient',
    {
      description:
        'Point every reading tool at one of the patients from mah_list_patients. The ' +
        'switch is confirmed with the portal before it is stored, and it survives ' +
        'restarts. Select the account holder to return to the default.',
      annotations: toolAnnotations({ readOnly: false, idempotent: true }),
      inputSchema: {
        patient_id: z.string().min(1).describe('id from mah_list_patients'),
      },
    },
    async ({ patient_id }) => {
      const all = await listPatients(client);
      const target = all.find((p) => p.id === patient_id);
      if (target === undefined) {
        throw new McpToolError(`No patient with id ${patient_id} is available to this login.`, {
          hint: `Available: ${all.map((p) => `${p.displayName} (${p.relationship})`).join(', ')}.`,
        });
      }
      const identity = await patients.select(client, target);
      return jsonResult({
        activePatient: identity.displayName,
        age: identity.age,
        relationship: target.relationship,
        confirmed: true,
      });
    },
  );
}
