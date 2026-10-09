import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
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
      inputSchema: z.object({ view: viewArg() }),
    },
    // Billing is one of the few areas with NO data endpoint — it issues no XHR,
    // so this parses the server-rendered page. If the markup changes the parse
    // yields [] and warns to stderr. There is deliberately no "return the page
    // HTML" option: the page carries unrelated PII in its headers plus the
    // hidden antiforgery token and CSP nonce, none of which belongs in a model
    // transcript. Inspect the page in a browser instead.
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const html = await client.page('Billing/Summary');
          const accounts = parseBillingAccounts(html);
          if (accounts.length === 0) {
            console.error(
              '[myatriumhealth-mcp] Billing/Summary: no account cards matched — the page ' +
                'markup may have changed; see docs/MYATRIUMHEALTH-API.md.',
            );
          }
          return accounts;
        }),
      );
    },
  );
}
