import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { MyAtriumHealthAuth } from '../src/auth.js';
import { MyAtriumHealthClient } from '../src/client.js';
import { PatientContext } from '../src/patient-context.js';
import type { MahTransport } from '../src/transport.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerMahHealthcheckTool } from '../src/tools/healthcheck.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerPatientTools } from '../src/tools/patients.js';
import { registerRecordTools } from '../src/tools/records.js';
import { registerResultTools } from '../src/tools/results.js';
import { registerVisitTools } from '../src/tools/visits.js';

/**
 * Fleet annotation invariants, read off `tools/list` (what clients see) rather
 * than a hand-kept list. `destructiveHint` DEFAULTS TO TRUE whenever
 * readOnlyHint is not true, so a write that forgets to declare it publishes as
 * destructive and nothing fails — a considered `true` and a forgotten one look
 * identical. `openWorldHint` likewise defaults to true when absent.
 *
 * Every registrar index.ts runs is called here; the count assertion guards
 * against one being dropped from this file.
 */
const stubTransport: MahTransport = {
  start: async () => {},
  close: async () => {},
  fetch: async () => ({ status: 200, body: '' }),
};

async function servedTools() {
  const client = new MyAtriumHealthClient({ transport: stubTransport });
  const patients = new PatientContext();
  const auth = new MyAtriumHealthAuth({
    credentials: () => ({ username: 'u', password: 'p' }),
    persistence: { load: () => null, save: () => {} },
  });
  const h = await createTestHarness((server) => {
    registerRecordTools(server, client, patients);
    registerResultTools(server, client, patients);
    registerVisitTools(server, client, patients);
    registerAccountTools(server, client, patients);
    registerBillingTools(server, client, patients);
    registerMessageTools(server, client, patients, { readOnly: false, attachmentsSupported: true });
    registerPatientTools(server, client, patients);
    registerAuthTools(server, auth);
    registerMahHealthcheckTool(server, client, { auth, bridge: undefined });
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools;
}

describe('tool annotations', () => {
  it('covers the full served surface', async () => {
    expect(await servedTools()).toHaveLength(23);
  });

  it('sets an explicit boolean destructiveHint on every write', async () => {
    const undeclared = (await servedTools())
      .filter((t) => t.annotations?.readOnlyHint !== true && typeof t.annotations?.destructiveHint !== 'boolean')
      .map((t) => t.name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', async () => {
    const contradictory = (await servedTools())
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool open-world (each one reaches the portal, directly or through the bridge)', async () => {
    const notOpen = (await servedTools())
      .filter((t) => t.annotations?.openWorldHint !== true)
      .map((t) => t.name);
    expect(notOpen).toEqual([]);
  });

  it('pins which writes are destructive', async () => {
    // mah_reply_message reaches a provider; mah_sign_in spends a login attempt
    // against an account that locks; mah_send_verification_code messages the
    // account holder; mah_verify_code spends a single-use code. None has an
    // inverse here. mah_set_active_patient does: calling it again restores the
    // previous selection.
    const writes = (await servedTools())
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => [t.name, t.annotations?.destructiveHint])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(writes).toEqual([
      ['mah_reply_message', true],
      ['mah_send_verification_code', true],
      ['mah_set_active_patient', false],
      ['mah_sign_in', true],
      ['mah_verify_code', true],
    ]);
  });
});
