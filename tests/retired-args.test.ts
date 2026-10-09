import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport as ClientInMemory } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { MyAtriumHealthClient } from '../src/client.js';
import type { FetchInit, FetchResult, MahTransport } from '../src/transport.js';
import { PatientContext } from '../src/patient-context.js';
import { registerBillingTools } from '../src/tools/billing.js';

const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;

// `raw` was removed from mah_list_billing_accounts (it leaked the page's
// antiforgery token, CSP nonce and header PII). Removing a parameter must not
// break a caller — a saved prompt, an agent that learnt the old schema — that
// still sends it: the argument is dropped and the parsed accounts come back,
// never the page HTML and never an invalid-params error.
describe('retired arguments are tolerated, not rejected', () => {
  it('mah_list_billing_accounts accepts a legacy raw:true and still returns parsed accounts', async () => {
    const pages: string[] = [];
    const transport: MahTransport = {
      start: async () => {},
      close: async () => {},
      fetch: async (init: FetchInit): Promise<FetchResult> => {
        pages.push(init.path);
        if (init.path.endsWith('FetchHealthSummary')) {
          return { status: 200, body: JSON.stringify({ patientFirstName: 'Christopher', header: { patientAge: 45 } }) };
        }
        return { status: 200, body: signedInPage };
      },
    };
    process.env.MAH_PATIENT_FILE = `/tmp/mah-retired-${Date.now()}-${Math.random()}.json`;
    const server = new McpServer({ name: 't', version: '0' });
    registerBillingTools(server, new MyAtriumHealthClient({ transport }), new PatientContext());
    const [clientSide, serverSide] = ClientInMemory.createLinkedPair();
    await server.connect(serverSide as never);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(clientSide);

    const res = (await client.callTool({
      name: 'mah_list_billing_accounts',
      arguments: { raw: true },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(res.isError ?? false).toBe(false);
    const text = res.content[0]!.text;
    expect(text).not.toMatch(/__RequestVerificationToken|<html/i);
    expect(pages).toContain('Billing/Summary');
    await client.close();
  });
});
