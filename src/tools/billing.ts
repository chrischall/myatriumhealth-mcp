import { z } from 'zod';
import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { viewArg, viewResponse } from '../view.js';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { parseBillingAccounts } from '../parse.js';

export function registerBillingTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
): void {
  server.registerTool(
    'mah_list_billing_accounts',
    {
      description:
        'List billing accounts with balance due, grouped as outstanding, zero-balance ' +
        'or guarantor-authorized. Amounts are returned as displayed (formatted strings).',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        view: viewArg(),
        raw: z
          .boolean()
          .default(false)
          .describe('Return the raw page HTML instead of parsed accounts, for debugging.'),
      },
    },
    // Billing is one of the few areas with NO data endpoint — it issues no XHR,
    // so this parses the server-rendered page. If the markup changes the parse
    // yields [], which is why `raw` exists as an escape hatch.
    async ({ raw, view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const html = await client.page('Billing/Summary');
          if (raw) return { html };
          const accounts = parseBillingAccounts(html);
          if (accounts.length === 0) {
            console.error(
              '[myatriumhealth-mcp] Billing/Summary: no account cards matched — the page ' +
                'markup may have changed. Re-run with raw:true to inspect.',
            );
          }
          return accounts;
        }),
      );
    },
  );
}
