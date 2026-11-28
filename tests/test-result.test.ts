import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MfaRequiredError } from '../src/auth.js';
import { MyAtriumHealthClient } from '../src/client.js';
import { PatientContext } from '../src/patient-context.js';
import { registerResultTools } from '../src/tools/results.js';
import type { FetchInit, FetchResult, MahTransport } from '../src/transport.js';
import { ServerTransport } from '../src/transport-server.js';

// Every value below is synthetic: made-up keys, names, values and markup in the
// SHAPE of the portal's test-results answers (as public MyChart clients
// describe them). No patient content.

const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<script id='cspScripts' nonce='0123456789abcdef0123456789abcdef'></script>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;
const loginPage = '<html><head><title>MyAtriumHealth - Login Page</title></head><body>sign in</body></html>';

const IMG = '33333333-aaaa-4bbb-8ccc-000000000003';

const labDetails = {
  orderName: 'SAMPLE PANEL',
  key: 'ORD-LAB-1',
  results: [
    {
      name: 'SAMPLE PANEL',
      key: 'RES-LAB-1',
      isAbnormal: true,
      showDetails: true,
      orderMetadata: {
        orderProviderName: 'Sample Orderer, MD',
        authorizingProviderName: 'Sample Authorizer, MD',
        prioritizedInstantISO: '2026-01-05T10:00:00Z',
        resultTimestampDisplay: 'Jan 5, 2026 10:00 AM',
        collectionTimestampsDisplay: 'Jan 4, 2026 8:00 AM',
        specimensDisplay: 'Blood',
        resultStatus: 'Final',
        resultType: 'LAB',
        resultingLab: { name: 'Sample Lab' },
      },
      resultComponents: [
        {
          componentInfo: { componentID: 'C1', name: 'Sample Analyte A', units: 'mg/dL' },
          componentResultInfo: {
            value: '12.5',
            numericValue: 12.5,
            referenceRange: { formattedReferenceRange: '1.0 - 10.0 mg/dL' },
            abnormalFlagCategoryValue: 'High',
          },
          componentComments: { contentAsString: 'Sample component note.', hasContent: true },
        },
        {
          componentInfo: { componentID: 'C2', name: 'Sample Analyte B', units: '' },
          componentResultInfo: {
            value: '{\\rtf1\\ansi Negative\\par}',
            isValueRtf: true,
            referenceRange: {},
            abnormalFlagCategoryValue: 'Unknown',
          },
        },
      ],
      providerComments: [
        { commentText: 'Sample comment with text.', providerName: 'Sample Orderer, MD', commentDate: '2026-01-06' },
        { wmgId: 'WMG-1' },
      ],
      reportDetails: {},
    },
  ],
};

const history = {
  historicalResults: {
    C1: {
      componentID: 'C1',
      name: 'Sample Analyte A',
      historicalResultData: [
        { dateISO: '2025-06-01', value: '8.0', referenceRange: { formattedReferenceRange: '1.0 - 10.0 mg/dL' } },
        { dateISO: '2026-01-05', value: '12.5', referenceRange: { formattedReferenceRange: '1.0 - 10.0 mg/dL' } },
      ],
    },
  },
};

const imagingDetails = {
  orderName: 'SAMPLE IMAGING STUDY',
  key: 'ORD-IMG-1',
  results: [
    {
      name: 'SAMPLE IMAGING STUDY',
      key: 'RES-IMG-1',
      isAbnormal: false,
      showDetails: true,
      orderMetadata: {
        orderProviderName: 'Sample Orderer, MD',
        readingProviderName: 'Sample Reader, MD',
        prioritizedInstantISO: '2026-02-01T09:00:00Z',
        resultStatus: 'Preliminary',
        resultType: 'IMAGING',
      },
      resultComponents: [],
      studyResult: {
        narrative: {
          contentAsHtml: '<div><style>.x{color:red}</style><p>FINDINGS: Sample finding one.</p><p>Sample finding two.</p></div>',
          contentAsString: 'FINDINGS: Sample finding one. Sample finding two.',
        },
        impression: { contentAsString: '{\\rtf1 IMPRESSION: Sample impression.\\par}', isRTF: true },
        addenda: [{ contentAsString: 'Sample addendum.' }],
      },
      resultNote: { contentAsString: 'Sample note to the patient.' },
      reportDetails: { reportID: 'RPT-1', reportVars: { ordId: 'ORDID-1', ordDat: 'ORDDAT-1' } },
      scans: [
        { scanType: 'Sample Scan', scanDate: '2026-02-01', dcsId: 'DCS-SCAN-1', fileExtension: 'PDF', viewerUrl: 'https://viewer.example/secret' },
      ],
      imageStudies: [{ studyDescription: 'Sample series', modality: 'XR', numberOfImages: 2, viewerUrl: 'https://viewer.example/s' }],
      linkedResults: [{ key: 'ORD-PATH-1', name: 'SAMPLE PATHOLOGY' }],
    },
  ],
};

const reportHtml =
  '<div class="report"><h3>Sample Report</h3><p>Sample report body.</p>' +
  `<img src="/myatriumhealth/Image/Load?fileName=${IMG}" alt="Sample figure"></div>`;

const notReleased = {
  orderName: 'SAMPLE PENDING',
  key: 'ORD-PEND-1',
  results: [
    {
      name: 'SAMPLE PENDING',
      key: 'RES-PEND-1',
      showDetails: false,
      warningType: 'NotReleased',
      warningMessage: 'This result has not been released to you yet.',
      resultComponents: [],
    },
  ],
};

type Answer = (init: FetchInit, body: Record<string, unknown>) => unknown;

function harness(answer: Answer) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const json = (v: unknown): FetchResult => ({ status: 200, body: JSON.stringify(v) });
  const transport: MahTransport = {
    start: async () => {},
    close: async () => {},
    fetch: async (init) => {
      if (!init.path.startsWith('api/')) return { status: 200, body: signedInPage };
      if (init.path.endsWith('FetchHealthSummary')) return json({ patientFirstName: 'Sample', header: { patientAge: 40 } });
      const body = (init.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
      calls.push({ path: init.path, body });
      return json(answer(init, body) ?? {});
    },
  };
  return run(transport, calls);
}

function run(transport: MahTransport, calls: { path: string; body: Record<string, unknown> }[] = []) {
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }>>();
  const server = {
    registerTool: (name: string, _def: unknown, fn: never) => handlers.set(name, fn),
  } as never;
  process.env.MAH_PATIENT_FILE = join(tmpdir(), `mah-result-${Date.now()}-${Math.random()}.json`);
  const client = new MyAtriumHealthClient({ transport });
  registerResultTools(server, client, new PatientContext());
  const call = (args: Record<string, unknown>) => handlers.get('mah_get_test_result')!({ includeHistory: true, ...args });
  const tool = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await handlers.get(name)!(args)).content[0]!.text!) as Record<string, unknown>;
  return {
    calls,
    call,
    tool,
    json: async (args: Record<string, unknown>) => JSON.parse((await call(args)).content[0]!.text!) as Record<string, unknown>,
  };
}

const standard: Answer = (init, body) => {
  if (init.path.endsWith('test-results/GetDetails')) {
    return { 'ORD-LAB-1': labDetails, 'ORD-IMG-1': imagingDetails, 'ORD-PEND-1': notReleased }[String(body.orderKey)] ??
      { orderName: '', key: '', results: [{}] };
  }
  if (init.path.endsWith('GetMultipleHistoricalResultComponents')) return history;
  if (init.path.endsWith('LoadReportContent')) return { reportContent: reportHtml, reportCss: '.x{}' };
  if (init.path.endsWith('test-results/GetList')) {
    return { newResults: {}, newComments: { 'WMG-1': { commentText: 'Resolved sample comment.', providerName: 'Sample Nurse, RN' } } };
  }
  return undefined;
};

describe('mah_get_test_result', () => {
  it('asks GetDetails for the order key, inside the untrusted-content envelope', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-LAB-1' });
    expect(out.untrusted_content).toBe(true);
    expect(String(out.note)).toMatch(/not instructions/);
    const details = h.calls.find((c) => c.path.endsWith('test-results/GetDetails'))!;
    expect(details.body).toEqual({ orderKey: 'ORD-LAB-1', organizationID: '', PageNonce: '' });
    expect(out).toMatchObject({ patient: expect.any(String), key: 'ORD-LAB-1', status: 'available', orderName: 'SAMPLE PANEL' });
  });

  it('returns the header and lab components with ranges, flags and history', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-LAB-1' });
    const [r] = out.results as Record<string, unknown>[];
    expect(r).toMatchObject({
      name: 'SAMPLE PANEL',
      resultType: 'LAB',
      status: 'Final',
      abnormal: true,
      collected: 'Jan 4, 2026 8:00 AM',
      resulted: 'Jan 5, 2026 10:00 AM',
      resultedIso: '2026-01-05T10:00:00Z',
      orderingProvider: 'Sample Orderer, MD',
      authorizingProvider: 'Sample Authorizer, MD',
      specimen: 'Blood',
      lab: 'Sample Lab',
    });
    const [a, b] = r!.components as Record<string, unknown>[];
    expect(a).toEqual({
      name: 'Sample Analyte A',
      value: '12.5',
      units: 'mg/dL',
      range: '1.0 - 10.0 mg/dL',
      flag: 'High',
      comment: 'Sample component note.',
      history: [
        { date: '2026-01-05', value: '12.5', range: '1.0 - 10.0 mg/dL' },
        { date: '2025-06-01', value: '8.0', range: '1.0 - 10.0 mg/dL' },
      ],
    });
    // An RTF value is plain text; the portal's "Unknown" flag is no flag.
    expect(b).toEqual({ name: 'Sample Analyte B', value: 'Negative' });
    const hist = h.calls.find((c) => c.path.endsWith('GetMultipleHistoricalResultComponents'))!;
    expect(hist.body).toMatchObject({ orderID: 'ORD-LAB-1', isInitialLoad: true });
  });

  it('resolves provider comments to text, looking up a bare reference in the results list', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-LAB-1' });
    const [r] = out.results as Record<string, unknown>[];
    expect(r!.comments).toEqual([
      { text: 'Sample comment with text.', provider: 'Sample Orderer, MD', date: '2026-01-06' },
      { text: 'Resolved sample comment.', provider: 'Sample Nurse, RN' },
    ]);
  });

  it('does not read the list when every comment already carries its text', async () => {
    const h = harness((init, body) =>
      init.path.endsWith('GetDetails')
        ? { ...labDetails, results: [{ ...labDetails.results[0], providerComments: [{ commentText: 'x' }] }] }
        : standard(init, body),
    );
    await h.call({ key: 'ORD-LAB-1' });
    expect(h.calls.some((c) => c.path.endsWith('test-results/GetList'))).toBe(false);
  });

  it('returns the narrative report for an imaging result as clean text, with image placeholders', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-IMG-1' });
    const [r] = out.results as Record<string, unknown>[];
    expect(r).toMatchObject({ resultType: 'IMAGING', status: 'Preliminary', readingProvider: 'Sample Reader, MD' });
    expect(r!.report).toEqual({
      narrative: 'FINDINGS: Sample finding one.\nSample finding two.',
      impression: 'IMPRESSION: Sample impression.',
      addenda: ['Sample addendum.'],
      text: `Sample Report\nSample report body.\n[image 1: fileName=${IMG}]`,
    });
    expect(r!.note).toBe('Sample note to the patient.');
    expect(r!.images).toEqual([{ index: 1, fileName: IMG, alt: 'Sample figure' }]);
    const report = h.calls.find((c) => c.path.endsWith('LoadReportContent'))!;
    expect(report.body).toMatchObject({ reportID: 'RPT-1', assumedVariables: { ordId: 'ORDID-1', ordDat: 'ORDDAT-1' } });
    // No component history is asked for a result without components.
    expect(h.calls.some((c) => c.path.endsWith('GetMultipleHistoricalResultComponents'))).toBe(false);
  });

  it('lists scans for mah_get_document, never a viewer URL, and links pathology', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-IMG-1' });
    const [r] = out.results as Record<string, unknown>[];
    expect(r!.scans).toEqual([
      { index: 1, type: 'Sample Scan', date: '2026-02-01', documentId: 'DCS-SCAN-1', fileExtension: 'pdf' },
    ]);
    expect(r!.imageStudies).toEqual([{ description: 'Sample series', modality: 'XR', images: 2 }]);
    expect(r!.linked).toEqual([{ key: 'ORD-PATH-1', name: 'SAMPLE PATHOLOGY' }]);
    expect(JSON.stringify(out)).not.toContain('viewer.example');
  });

  it('keeps the result when the report text cannot be loaded, and says so', async () => {
    const h = harness((init, body) => {
      if (init.path.endsWith('LoadReportContent')) throw new Error('boom');
      return standard(init, body);
    });
    const out = await h.json({ key: 'ORD-IMG-1' });
    const [r] = out.results as Record<string, unknown>[];
    expect((r!.report as Record<string, unknown>).narrative).toMatch(/Sample finding one/);
    expect(String((out.notes as string[]).join(' '))).toMatch(/report/i);
  });

  it('says plainly when a result has not been released', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-PEND-1' });
    expect(out.status).toBe('not-released');
    expect(String(out.statusNote)).toMatch(/released/i);
    const [r] = out.results as Record<string, unknown>[];
    expect(r).toMatchObject({ name: 'SAMPLE PENDING', released: false, warning: 'This result has not been released to you yet.' });
  });

  it('says when the portal knows no such result (its empty envelope), never empty data', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-NOPE' });
    expect(out.status).toBe('not-found');
    expect(String(out.statusNote)).toMatch(/mah_list_test_results/);
    expect(out.results).toBeUndefined();
  });

  it('returns the portal answer untouched with view: "full", making one request', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-IMG-1', view: 'full' });
    expect(out.untrusted_content).toBe(true);
    expect(out.details).toEqual(imagingDetails);
    expect(h.calls.map((c) => c.path.split('/').pop())).toEqual(['GetDetails']);
  });

  it('skips the history when includeHistory is false', async () => {
    const h = harness(standard);
    const out = await h.json({ key: 'ORD-LAB-1', includeHistory: false });
    expect(h.calls.some((c) => c.path.endsWith('GetMultipleHistoricalResultComponents'))).toBe(false);
    const [r] = out.results as Record<string, unknown>[];
    expect((r!.components as Record<string, unknown>[])[0]!.history).toBeUndefined();
  });
});

describe('mah_get_test_result with bridge-less sign-in and an expired session', () => {
  it('surfaces the verification-code flow', async () => {
    let signedIn = true;
    let logins = 0;
    const auth = {
      credentialsRejected: false,
      mfaPending: false,
      isSignedIn: async () => signedIn,
      login: async () => {
        logins++;
        throw new MfaRequiredError(['sms', 'email']);
      },
      persistIfDirty: () => {},
      challengeContext: async () => null,
      request: async (path: string) => {
        if (path.endsWith('test-results/GetDetails')) {
          signedIn = false;
          return { res: new Response(null, { status: 200 }), body: loginPage };
        }
        return {
          res: new Response(null, { status: 200 }),
          body: path.startsWith('api/')
            ? JSON.stringify({ patientFirstName: 'Sample', header: { patientAge: 40 } })
            : signedInPage,
        };
      },
    };
    const h = run(new ServerTransport(auth as never));
    const err = await h.call({ key: 'ORD-LAB-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MfaRequiredError);
    expect(logins).toBe(1);
  });
});

describe('mah_list_test_results comments', () => {
  it('gives provider comments as plain text, never Epic HTML', async () => {
    const h = harness((init) =>
      init.path.endsWith('GetList')
        ? {
            newResults: {
              'RES-LAB-1^': {
                name: 'SAMPLE PANEL',
                key: 'RES-LAB-1',
                orderMetadata: {},
                providerComments: [
                  { content: '<div class="fmtConv"><p>The sample&#39;s values are &quot;fine&quot;.</p><p>&nbsp;</p><p>Recheck later.</p></div>' },
                  { content: 'Plain comment.\r\nSecond line.' },
                ],
              },
            },
          }
        : undefined,
    );
    const out = await h.tool('mah_list_test_results', { view: 'compact' });
    const [item] = (out.data as { items: { comments?: string[] }[] }).items;
    expect(item!.comments).toEqual(['The sample\'s values are "fine".\n\nRecheck later.', 'Plain comment.\nSecond line.']);
  });
});

describe('mah_list_test_results key', () => {
  it('gives each result the order key mah_get_test_result takes', async () => {
    const h = harness((init) =>
      init.path.endsWith('GetList')
        ? {
            groupBy: 'ORDER',
            newResultGroups: [{ key: 'ORD-LAB-1', resultList: ['RES-LAB-1'] }],
            newResults: {
              'RES-LAB-1^': { name: 'SAMPLE PANEL', key: 'RES-LAB-1', orderMetadata: {} },
              'RES-LONE^': { name: 'SAMPLE LONE', key: 'RES-LONE', orderMetadata: {} },
            },
          }
        : undefined,
    );
    const out = await h.tool('mah_list_test_results', { view: 'compact' });
    expect((out.data as { items: unknown[] }).items).toEqual([
      { key: 'ORD-LAB-1', name: 'SAMPLE PANEL' },
      { key: 'RES-LONE', name: 'SAMPLE LONE' },
    ]);
  });
});
