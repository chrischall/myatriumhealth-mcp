import { describe, expect, it } from 'vitest';
import { parseDetails } from '../src/test-result.js';
import { componentText } from '../src/message-html.js';

// Synthetic markup in the SHAPE of Epic's "fmtConv" HTML as pathology result
// components carry it: a wrapper div with a style block, bold heading divs, a
// tab spacer span, LISTBEGIN/LISTEND anchors, &nbsp;-only paragraphs and
// escaped quotes. No patient content, no real case numbers.

const DIAGNOSIS =
  '<div class="fmtConv"><style>.fmtConv p { margin: 0; } .tab { display: inline-block; }</style>' +
  '<div style="font-weight:bold;font-family:Arial">A.<span class="tab" style="width:36px">' +
  '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>COLON, SIGMOID, BIOPSY:</div>' +
  '<p>&nbsp;</p>' +
  '<div><a name="LISTBEGIN|1|SAMPLE"></a>HYPERPLASTIC POLYP.<a name="LISTEND|1|SAMPLE"></a></div>' +
  '<p>&nbsp;</p>' +
  '<div style="font-weight:bold">B.<span class="tab"></span>RECTUM, BIOPSY:</div>' +
  '<p>&nbsp;</p>' +
  '<div>TUBULAR ADENOMA.</div>' +
  '</div>';

const QUOTES =
  '<div class="fmtConv"><p>The specimen&#39;s label reads &quot;A&quot;.</p>' +
  '<p>Point&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;of&nbsp;service: Sample Lab</p></div>';

const CASE_REPORT = 'SAMPLE CASE REPORT\r\n  Case:        XX-00-0000\r\n  Collected:   Jan 1, 2026\r\n';

function clean(s: string | undefined): void {
  expect(s).toBeDefined();
  expect(s).not.toMatch(/<[a-z/!]/i);
  expect(s).not.toMatch(/&(#\d+|#x[0-9a-f]+|[a-z]+);/i);
  expect(s).not.toMatch(/ {10,}/);
  expect(s).not.toMatch(/[ \t]\n/);
}

describe('componentText', () => {
  it('renders fmtConv HTML as plain text: no tags, entities or space runs', () => {
    const t = componentText(DIAGNOSIS);
    clean(t);
    expect(t).toBe('A. COLON, SIGMOID, BIOPSY:\n\nHYPERPLASTIC POLYP.\n\nB. RECTUM, BIOPSY:\n\nTUBULAR ADENOMA.');
  });

  it('unescapes quotes and turns &nbsp; runs into one space', () => {
    const t = componentText(QUOTES);
    clean(t);
    expect(t).toBe('The specimen\'s label reads "A".\nPoint of service: Sample Lab');
  });

  it('leaves preformatted plain text alone apart from \\r\\n → \\n', () => {
    expect(componentText(CASE_REPORT)).toBe('SAMPLE CASE REPORT\n  Case:        XX-00-0000\n  Collected:   Jan 1, 2026');
  });

  it('leaves a one-line value as is, comparison signs included', () => {
    expect(componentText('12.5')).toBe('12.5');
    expect(componentText('<0.5')).toBe('<0.5');
    expect(componentText('>60')).toBe('>60');
    expect(componentText('Negative <5% & stable')).toBe('Negative <5% & stable');
  });

  it('is absent for an empty value', () => {
    expect(componentText('')).toBeUndefined();
    expect(componentText('   ')).toBeUndefined();
    expect(componentText(undefined)).toBeUndefined();
  });
});

describe('parseDetails component text', () => {
  const details = {
    orderName: 'SAMPLE SURGICAL PATHOLOGY',
    results: [
      {
        name: 'SAMPLE SURGICAL PATHOLOGY',
        key: 'RES-PATH-1',
        resultComponents: [
          { componentInfo: { componentID: 'P1', name: 'Final Diagnosis' }, componentResultInfo: { value: DIAGNOSIS } },
          { componentInfo: { componentID: 'P2', name: 'Point of Service' }, componentResultInfo: { value: QUOTES } },
          { componentInfo: { componentID: 'P3', name: 'Case Report' }, componentResultInfo: { value: CASE_REPORT } },
          {
            componentInfo: { componentID: 'P4', name: 'Disclaimer' },
            componentResultInfo: { value: 'See note.' },
            componentComments: { contentAsString: QUOTES },
          },
        ],
      },
    ],
  };
  const history = {
    historicalResults: {
      P1: { componentID: 'P1', historicalResultData: [{ dateISO: '2026-01-05', value: DIAGNOSIS }] },
      P3: { componentID: 'P3', historicalResultData: [{ dateISO: '2026-01-05', value: CASE_REPORT }] },
    },
  };

  it('cleans every component value, comment and history value', () => {
    const [r] = parseDetails(details, history).results;
    const comps = r!.out['components'] as Record<string, unknown>[];
    const byName = new Map(comps.map((c) => [c['name'], c]));
    expect(byName.get('Final Diagnosis')!['value']).toBe(
      'A. COLON, SIGMOID, BIOPSY:\n\nHYPERPLASTIC POLYP.\n\nB. RECTUM, BIOPSY:\n\nTUBULAR ADENOMA.',
    );
    clean(byName.get('Point of Service')!['value'] as string);
    expect(byName.get('Case Report')!['value']).toBe('SAMPLE CASE REPORT\n  Case:        XX-00-0000\n  Collected:   Jan 1, 2026');
    clean(byName.get('Disclaimer')!['comment'] as string);
    const h1 = byName.get('Final Diagnosis')!['history'] as { value?: string }[];
    expect(h1[0]!.value).toBe(byName.get('Final Diagnosis')!['value']);
    const h3 = byName.get('Case Report')!['history'] as { value?: string }[];
    expect(h3[0]!.value).toBe(byName.get('Case Report')!['value']);
    expect(JSON.stringify(r!.out)).not.toMatch(/fmtConv|&nbsp;|&#39;|LISTBEGIN/);
  });
});
