// Reading one result order (`api/test-results/GetDetails`) into what a person
// asks about: the header, the values with their ranges, the report text and
// the comments. The shapes come from public MyChart clients, NOT from a capture
// on this portal (docs/MYATRIUMHEALTH-API.md "Test result details"), so every
// field is read loosely: a missing or mistyped one is absent, never a throw.

import { messageHtmlToText, type MessageImage } from './message-html.js';
import { looksLikeRtf, rtfToText } from './rtf.js';
import { tidy } from './tools/_project.js';

type Rec = Record<string, unknown>;

/** Most report text kept per part; a report is rarely near this. */
export const REPORT_TEXT_MAX_CHARS = 60_000;
/** Trend points kept per component, newest first. */
export const HISTORY_POINTS = 10;

const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
};
const first = (...vs: unknown[]): string | undefined => {
  for (const v of vs) {
    const s = str(v);
    if (s !== undefined) return s;
  }
  return undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Text and images gathered for one result, numbered across all its parts. */
class Collector {
  readonly images: MessageImage[] = [];

  /** Plain text of an Epic text part: HTML, RTF or plain, whichever it carries. */
  text(part: unknown): string | undefined {
    if (typeof part === 'string') return this.render(part, undefined);
    const p = rec(part);
    return this.render(p['contentAsString'] ?? p['commentText'] ?? p['content'] ?? p['text'], p['contentAsHtml'] ?? p['html']);
  }

  render(plain: unknown, html: unknown): string | undefined {
    const h = str(html);
    if (h !== undefined) {
      const t = this.html(h);
      if (t !== undefined) return t;
    }
    const s = typeof plain === 'string' ? plain : undefined;
    if (s === undefined) return undefined;
    if (looksLikeRtf(s)) return cap(rtfToText(s));
    if (/<\/?[a-z][^>]*>/i.test(s)) return this.html(s);
    return cap(s.trim());
  }

  /** HTML as text, its images renumbered after the ones already seen. */
  html(markup: string): string | undefined {
    const { text, images } = messageHtmlToText(markup);
    const offset = this.images.length;
    for (const img of images) this.images.push({ ...img, index: img.index + offset });
    const renumbered =
      offset === 0 ? text : text.replace(/\[image (\d+):/g, (_m, d: string) => `[image ${Number(d) + offset}:`);
    return cap(renumbered);
  }
}

function cap(t: string): string | undefined {
  if (t === '') return undefined;
  return t.length > REPORT_TEXT_MAX_CHARS ? `${t.slice(0, REPORT_TEXT_MAX_CHARS)} … [cut at ${REPORT_TEXT_MAX_CHARS} characters]` : t;
}

/** One provider comment, before a bare reference is resolved. */
export interface CommentOut {
  text?: string;
  provider?: string;
  date?: string;
  /** The comment's message id, when the result only referenced it. */
  ref?: string;
}

function comment(c: unknown, col: Collector): CommentOut {
  if (typeof c === 'string') return tidy({ text: col.text(c) }) as CommentOut;
  const r = rec(c);
  return tidy({
    text: col.text(r),
    provider: first(r['providerName'], r['authorName'], r['author'], rec(r['author'])['name']),
    date: first(r['commentDate'], r['dateISO'], r['instantISO'], r['date']),
    ref: first(r['wmgId'], r['commentId'], r['id'], r['key']),
  }) as CommentOut;
}

/** A comment the list's `newComments` holds, looked up by its reference. */
export function resolveComment(entry: unknown): CommentOut | undefined {
  const col = new Collector();
  const c = comment(entry, col);
  return c.text === undefined ? undefined : c;
}

type HistoryPoint = { date?: string; value?: string; range?: string };

function historyOf(raw: unknown): Map<string, HistoryPoint[]> {
  const out = new Map<string, HistoryPoint[]>();
  for (const [id, h] of Object.entries(rec(rec(raw)['historicalResults']))) {
    const points = list(rec(h)['historicalResultData']).map((p) => {
      const r = rec(p);
      const v = typeof r['value'] === 'string' && (r['isValueRtf'] === true || looksLikeRtf(r['value'])) ? rtfToText(r['value']) : r['value'];
      return tidy({
        date: first(r['dateISO'], r['date']),
        value: str(v),
        range: str(rec(r['referenceRange'])['formattedReferenceRange']),
      }) as HistoryPoint;
    });
    points.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    out.set(str(rec(h)['componentID']) ?? id, points.slice(0, HISTORY_POINTS));
  }
  return out;
}

function component(c: unknown, col: Collector, history: Map<string, HistoryPoint[]>): Rec {
  const r = rec(c);
  const info = rec(r['componentInfo']);
  const res = rec(r['componentResultInfo']);
  const raw = res['value'];
  const value = typeof raw === 'string' && (res['isValueRtf'] === true || looksLikeRtf(raw)) ? rtfToText(raw) : raw;
  // The portal sends "Unknown" when it has no verdict; that is no flag.
  const flag = str(res['abnormalFlagCategoryValue'] ?? res['abnormalFlag'] ?? res['flag']);
  const id = str(info['componentID']);
  const hist = id === undefined ? undefined : history.get(id);
  return tidy({
    name: first(info['name'], info['commonName']),
    value: str(value),
    units: str(info['units']),
    range: str(rec(res['referenceRange'])['formattedReferenceRange']),
    flag: flag === undefined || /^(unknown|none|normal)$/i.test(flag) ? undefined : flag,
    comment: col.text(r['componentComments']),
    history: hist !== undefined && hist.length > 0 ? hist : undefined,
  });
}

const LINK_FIELDS = ['linkedResults', 'relatedResults', 'linkedOrders', 'pathologyResults', 'associatedResults'];
const NOT_RELEASED = /releas|not (yet )?available|pending review|not been reviewed/i;

/** What the tool returns for one result, before the report text is joined on. */
export interface ResultOut {
  out: Rec;
  /** Set when the result names a rendered report to fetch. */
  report?: { reportID: string; ordId: string; ordDat: string };
  /** Comments that are only a reference; resolved from the list. */
  pendingComments: number[];
  collector: Collector;
}

function result(raw: unknown, history: Map<string, HistoryPoint[]>): ResultOut {
  const r = rec(raw);
  const meta = rec(r['orderMetadata']);
  const col = new Collector();
  const study = rec(r['studyResult']);
  const components = list(r['resultComponents']).map((c) => component(c, col, history));
  const addenda = list(study['addenda']).map((a) => col.text(a)).filter((t): t is string => t !== undefined);
  const report = tidy({
    narrative: col.text(study['narrative']),
    impression: col.text(study['impression']),
    addenda: addenda.length > 0 ? addenda : undefined,
  });
  const comments = list(r['providerComments']).map((c) => comment(c, col));
  const scans = list(r['scans']).map((s, i) => {
    const x = rec(s);
    const ext = first(x['fileExtension'], x['docExt'], x['dcsExt']);
    return tidy({
      index: i + 1,
      type: first(x['scanType'], x['type'], x['documentType']),
      date: first(x['scanDate'], x['date']),
      description: first(x['description'], x['displayName'], x['name']),
      documentId: first(x['dcsId'], x['dcsID'], x['documentId']),
      fileExtension: ext?.toLowerCase(),
    });
  });
  const studies = list(r['imageStudies']).map((s) => {
    const x = rec(s);
    return tidy({
      description: str(x['studyDescription']),
      modality: str(x['modality']),
      date: str(x['studyDate']),
      images: typeof x['numberOfImages'] === 'number' ? x['numberOfImages'] : undefined,
    });
  });
  const linked = LINK_FIELDS.flatMap((f) => list(r[f])).map((l) => {
    const x = rec(l);
    return tidy({ key: first(x['key'], x['orderKey'], x['orderID']), name: first(x['name'], x['orderName']) });
  }).filter((l) => Object.keys(l).length > 0);
  const warning = first(r['warningMessage']);
  const hasContent =
    components.length > 0 || Object.keys(report).length > 0 || comments.length > 0 || scans.length > 0;
  const released =
    (warning !== undefined && NOT_RELEASED.test(`${warning} ${str(r['warningType']) ?? ''}`)) ||
    (r['showDetails'] === false && !hasContent)
      ? false
      : undefined;
  const rd = rec(r['reportDetails']);
  const reportID = str(rd['reportID']);
  const vars = rec(rd['reportVars']);
  const out: Rec = {
    name: str(r['name']),
    resultType: str(meta['resultType']),
    status: str(meta['resultStatus']),
    abnormal: bool(r['isAbnormal']),
    released,
    warning,
    collected: str(meta['collectionTimestampsDisplay']),
    resulted: first(meta['resultTimestampDisplay'], meta['prioritizedInstantDisplay']),
    resultedIso: str(meta['prioritizedInstantISO']),
    updatedIso: str(meta['latestUpdateInstantISO']),
    orderingProvider: str(meta['orderProviderName']),
    authorizingProvider: str(meta['authorizingProviderName']),
    readingProvider: str(meta['readingProviderName']),
    specimen: str(meta['specimensDisplay']),
    lab: str(rec(meta['resultingLab'])['name']),
    components: components.length > 0 ? components : undefined,
    report: Object.keys(report).length > 0 ? report : undefined,
    note: col.text(r['resultNote']),
    letter: col.text(r['resultLetter']),
    comments: comments.length > 0 ? comments : undefined,
    scans: scans.length > 0 ? scans : undefined,
    imageStudies: studies.length > 0 ? studies : undefined,
    linked: linked.length > 0 ? linked : undefined,
  };
  return {
    out,
    ...(reportID !== undefined
      ? { report: { reportID, ordId: str(vars['ordId']) ?? '', ordDat: str(vars['ordDat']) ?? '' } }
      : {}),
    pendingComments: comments.flatMap((c, i) => (c.text === undefined && c.ref !== undefined ? [i] : [])),
    collector: col,
  };
}

export interface ParsedDetails {
  orderName?: string;
  results: ResultOut[];
  /** The portal's answer for a key it does not know: blank name, no named result. */
  empty: boolean;
}

/** Whether a details answer has components worth a history request. */
export function hasComponents(raw: unknown): boolean {
  return list(rec(raw)['results']).some((r) => list(rec(r)['resultComponents']).length > 0);
}

export function parseDetails(raw: unknown, history: unknown = undefined): ParsedDetails {
  const d = rec(raw);
  const hist = historyOf(history);
  const named = list(d['results']).filter((r) => str(rec(r)['name']) !== undefined || str(rec(r)['key']) !== undefined);
  const orderName = str(d['orderName']);
  return {
    ...(orderName !== undefined ? { orderName } : {}),
    results: named.map((r) => result(r, hist)),
    empty: orderName === undefined && named.length === 0,
  };
}

/** Join a rendered report onto its result as `report.text`, its images numbered on. */
export function joinReport(r: ResultOut, answer: unknown): void {
  const html = str(rec(answer)['reportContent']);
  if (html === undefined) return;
  const text = r.collector.html(html);
  if (text === undefined) return;
  r.out['report'] = { ...rec(r.out['report']), text };
}

/** The finished record for one result. */
export function finish(r: ResultOut): Rec {
  return tidy({ ...r.out, images: r.collector.images.length > 0 ? r.collector.images : undefined });
}
