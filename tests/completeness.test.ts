import { describe, expect, it } from 'vitest';
import { MyAtriumHealthClient } from '../src/client.js';
import type { FetchInit, FetchResult, MahTransport } from '../src/transport.js';
import { PatientContext } from '../src/patient-context.js';
import { registerResultTools } from '../src/tools/results.js';
import { registerVisitTools } from '../src/tools/visits.js';

// The compact projections reduced these responses to a bare array, dropping
// the portal's own "there is more" flags — so a first page of lab results or
// visits read as the patient's complete history.
const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function harness(answer: (init: FetchInit) => unknown) {
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
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, fn: Handler) => handlers.set(name, fn),
  } as never;
  process.env.MAH_PATIENT_FILE = `/tmp/mah-complete-${Date.now()}-${Math.random()}.json`;
  const client = new MyAtriumHealthClient({ transport });
  const patients = new PatientContext();
  registerResultTools(server, client, patients);
  registerVisitTools(server, client, patients);
  return async (tool: string, args: Record<string, unknown> = {}) =>
    JSON.parse((await handlers.get(tool)!(args)).content[0]!.text) as {
      data: Record<string, unknown>;
    };
}

const results = (fullyLoaded: boolean) => ({
  newResults: {
    h1: { name: 'CBC', isAbnormal: false, orderMetadata: { prioritizedInstantISO: '2026-09-01T00:00:00Z' } },
  },
  organizationLoadMoreInfo: { local: { hasMore: !fullyLoaded } },
  areResultsFullyLoaded: fullyLoaded,
});

describe('mah_list_test_results compact', () => {
  it('says when the portal has not loaded every result', async () => {
    const call = harness(() => results(false));
    const out = await call('mah_list_test_results');
    expect(out.data).toMatchObject({ items: [{ name: 'CBC' }], complete: false });
    expect(String(out.data.note)).toMatch(/not.*all|more/i);
  });

  it('says when the list is complete', async () => {
    const call = harness(() => results(true));
    const out = await call('mah_list_test_results');
    expect(out.data).toMatchObject({ items: [{ name: 'CBC' }], complete: true });
    expect(out.data.note).toBeUndefined();
  });
});

const past = (more: boolean) => ({
  List: {
    org1: {
      Organization: { OrganizationName: 'Atrium Health' },
      List: [{ PrimaryDate: '9/1/2026', Csn: '1' }],
      ListSize: 1,
      HasMoreData: more,
    },
  },
});

describe('mah_list_past_visits compact', () => {
  it('says when older visits exist, and how to page back', async () => {
    const call = harness(() => past(true));
    const out = await call('mah_list_past_visits');
    expect(out.data).toMatchObject({ items: [{ csn: '1' }], complete: false });
    expect(String(out.data.note)).toMatch(/before/);
  });

  it('says when there is nothing older', async () => {
    const call = harness(() => past(false));
    const out = await call('mah_list_past_visits');
    expect(out.data).toMatchObject({ items: [{ csn: '1' }], complete: true });
    expect(out.data.note).toBeUndefined();
  });
});
