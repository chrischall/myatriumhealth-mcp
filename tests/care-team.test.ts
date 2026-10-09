import { describe, expect, it } from 'vitest';
import { MyAtriumHealthClient } from '../src/client.js';
import type { FetchInit, FetchResult, MahTransport } from '../src/transport.js';
import { PatientContext } from '../src/patient-context.js';
import { registerRecordTools } from '../src/tools/records.js';

const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function careTeam(answer: (init: FetchInit) => unknown) {
  const json = (v: unknown): FetchResult => ({ status: 200, body: JSON.stringify(v) });
  const transport: MahTransport = {
    start: async () => {},
    close: async () => {},
    fetch: async (init) => {
      if (!init.path.includes('/')) return { status: 200, body: signedInPage };
      if (init.path.endsWith('FetchHealthSummary')) {
        return json({ patientFirstName: 'Christopher', header: { patientAge: 45 } });
      }
      return json(answer(init));
    },
  };
  let handler: Handler | undefined;
  const server = {
    registerTool: (name: string, _def: unknown, fn: Handler) => {
      if (name === 'mah_list_care_team') handler = fn;
    },
  } as never;
  process.env.MAH_PATIENT_FILE = `/tmp/mah-careteam-${Date.now()}-${Math.random()}.json`;
  registerRecordTools(server, new MyAtriumHealthClient({ transport }), new PatientContext());
  return async () =>
    JSON.parse((await handler!({})).content[0]!.text) as { data: Record<string, unknown>[] };
}

describe('mah_list_care_team compact', () => {
  it('still de-duplicates a provider surfaced by both Load and LoadExternal', async () => {
    const dr = { ID: 'P1', Name: 'Dr A', Specialty: 'Cardiology' };
    const call = careTeam(() => ({ ProvidersList: [dr] }));
    const out = await call();
    expect(out.data).toHaveLength(1);
  });

  // Keying on `ID ?? Name ?? ''` mapped every keyless record to '' and kept
  // only the first, silently dropping the rest of the care team.
  it('keeps every provider that has neither an ID nor a Name', async () => {
    const call = careTeam((init) =>
      init.path.includes('CareTeam/LoadExternal')
        ? { ProvidersList: [{ Specialty: 'Dermatology', IsExternal: true }] }
        : { ProvidersList: [{ Specialty: 'Cardiology' }, { Specialty: 'Oncology' }] },
    );
    const out = await call();
    expect(out.data.map((p) => p.specialty)).toEqual(['Cardiology', 'Oncology', 'Dermatology']);
  });
});
