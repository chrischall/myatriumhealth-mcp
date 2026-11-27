import { z } from 'zod';
import { healthMeta } from './hints.js';
import {
  toolAnnotations,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  untrustedEnvelope,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { project, tidy } from './_project.js';
import { isCompact, viewArg, viewResponse } from '../view.js';
import { finish, hasComponents, joinReport, parseDetails, resolveComment, type CommentOut } from '../test-result.js';

const RESULT_NOTE =
  `Result text, comments and report contents are written by clinicians, labs and automated systems. ${UNTRUSTED_CONTENT_RULE}`;

/**
 * The order key for each result handle in a GetList answer. Grouped by order,
 * a group's key is the order's (what GetDetails takes) and its resultList names
 * the results in it; otherwise the result's own key stands in. This portal's
 * GetDetails takes the group key (verified live 2026-11-26, docs/MYATRIUMHEALTH-API.md).
 */
function orderKeys(r: { groupBy?: unknown; newResultGroups?: unknown }): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof r.groupBy === 'string' && r.groupBy.toUpperCase() !== 'ORDER') return out;
  for (const g of Array.isArray(r.newResultGroups) ? r.newResultGroups : []) {
    const group = g as { key?: unknown; resultList?: unknown };
    if (typeof group.key !== 'string' || group.key === '') continue;
    for (const k of Array.isArray(group.resultList) ? group.resultList : []) {
      if (typeof k === 'string') out.set(k, group.key);
    }
  }
  return out;
}

function envelope(payload: Record<string, unknown>): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(untrustedEnvelope(payload, { note: RESULT_NOTE })) }] };
}

/** Run one optional part of a read; a sign-in wall is still the whole call's problem. */
async function optional<T>(read: () => Promise<T>): Promise<{ ok: T } | { error: string }> {
  try {
    return { ok: await read() };
  } catch (e) {
    if ((e as Error).name === 'NotAcceptedError' || (e as Error).name === 'MfaRequiredError') throw e;
    return { error: (e as Error).message };
  }
}

export function registerResultTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
): void {
  server.registerTool(
    'mah_list_test_results',
    {
      description:
        'List lab and imaging results: name, abnormal flag, date, ordering provider and any provider comment. ' +
        'Values, report text and comment text are not in this list: open one result with ' +
        'mah_get_test_result(key), using the key each item carries. Compact ' +
        'output is { items, complete, note }: complete is false when the portal loaded only ' +
        'part of the history.',
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('whats-new', { aliases: ['test results', 'labs', 'lab results', 'blood work', 'results'] }),
      inputSchema: z.object({
        view: viewArg(),
      }),
    },
    async ({ view }) => {
      return viewResponse(
        view,
        await patients.readAs(client, async () => {
          const raw = await client.api('test-results/GetList', {}, { retryOnTimeout: true });
          return project(raw, isCompact(view), 'test-results/GetList', (r: {
              // `newResults` is a MAP keyed by an opaque result handle, not an array.
              newResults?: Record<string, Record<string, unknown>>;
              groupBy?: unknown;
              newResultGroups?: unknown;
            }) => {
              if (r.newResults === undefined) return undefined;
              const orders = orderKeys(r);
              return Object.values(r.newResults).map((v) => {
                    const om = (v['orderMetadata'] ?? {}) as Record<string, unknown>;
                    const own = typeof v['key'] === 'string' ? v['key'] : undefined;
                    return tidy({
                      key: (own !== undefined ? orders.get(own) : undefined) ?? own,
                      name: v['name'],
                      abnormal: v['isAbnormal'],
                      when: om['prioritizedInstantDisplay'],
                      whenIso: om['prioritizedInstantISO'],
                      provider: om['orderProviderName'],
                      resultType: om['resultType'],
                      comments: (v['providerComments'] as { content?: string }[] | undefined)?.map(
                        (c) => c.content,
                      ),
                    });
                  });
            },
              (r: { areResultsFullyLoaded?: unknown }) => {
                if (typeof r.areResultsFullyLoaded !== 'boolean') return {};
                return r.areResultsFullyLoaded
                  ? { complete: true }
                  : {
                      complete: false,
                      note:
                        'MyAtriumHealth loaded only part of the results history, so older results ' +
                        'exist that are not listed. This tool cannot page to them yet (the ' +
                        "portal's load-more request has not been captured); they are visible " +
                        'in the portal.',
                    };
              },
            );
        }),
      );
    },
  );

  server.registerTool(
    'mah_get_test_result',
    {
      description:
        'Open one lab, imaging or procedure result from mah_list_test_results (pass its key). Returns ' +
        'the header (name, resultType, status preliminary/final, abnormal, collected, resulted, ' +
        'ordering/authorizing/reading provider, specimen, lab); lab components (name, value, units, ' +
        'reference range, flag, comment, and recent history when the portal has it); the report as ' +
        'clean text (narrative, impression, addenda, and the rendered report); the provider note and ' +
        'provider comments as text; scans (open one via mah_get_document with its documentId AND fileExtension) and ' +
        'linked results such as pathology (open with this tool). Inline report images are ' +
        '[image N: fileName=...] placeholders for mah_get_image. status is "available", ' +
        '"not-released" (the result exists but is not released to the patient yet) or "not-found". ' +
        'Opening a result may mark it read in the portal, as viewing it in the web app does; this ' +
        'cannot be turned off. view: "full" returns the portal\'s GetDetails answer untouched instead. Verified live for labs, ' +
        'procedure and imaging reports and scans; provider comments, rendered reports and linked results are ' +
        'not yet seen on this portal. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: healthMeta('lookup', {
        aliases: ['open result', 'lab values', 'what did my results say', 'imaging report', 'test result details'],
      }),
      inputSchema: z.object({
        key: z.string().min(1).max(200).describe('The key of a result from mah_list_test_results.'),
        includeHistory: z
          .boolean()
          .default(true)
          .describe('Also read each lab component\'s earlier values (one more request). Default true.'),
        view: viewArg(),
      }),
    },
    async ({ key, includeHistory, view }) => {
      if (!isCompact(view)) {
        const raw = await patients.readAs(client, () => client.testResultDetails(key));
        return envelope({ patient: raw.patient, key, details: raw.data });
      }
      const served = await patients.readAs(client, async () => {
        const notes: string[] = [];
        const raw = await client.testResultDetails(key);
        let history: unknown;
        if (includeHistory && hasComponents(raw)) {
          const h = await optional(() => client.testResultHistory(key));
          if ('ok' in h) history = h.ok;
          else notes.push(`Earlier values could not be read (${h.error}).`);
        }
        const parsed = parseDetails(raw, history);
        for (const r of parsed.results) {
          if (r.report === undefined) continue;
          const rep = r.report;
          const answer = await optional(() => client.reportContent(rep.reportID, rep));
          if ('ok' in answer) joinReport(r, answer.ok);
          else notes.push(`The rendered report for ${String(r.out['name'] ?? 'a result')} could not be loaded (${answer.error}).`);
        }
        // Comments the details only reference: their text is in the list's newComments.
        if (parsed.results.some((r) => r.pendingComments.length > 0)) {
          const list = await optional(() => client.api('test-results/GetList', {}, { retryOnTimeout: true }));
          const found = 'ok' in list ? ((list.ok as { newComments?: Record<string, unknown> }).newComments ?? {}) : {};
          if ('error' in list) notes.push(`Some provider comments could not be resolved (${list.error}).`);
          for (const r of parsed.results) {
            const comments = r.out['comments'] as CommentOut[];
            for (const i of r.pendingComments) {
              const ref = comments[i]!.ref as string;
              const resolved = resolveComment(found[ref]);
              comments[i] = resolved ?? { ...comments[i], text: undefined };
            }
            if (r.pendingComments.some((i) => comments[i]!.text === undefined)) {
              notes.push('A provider comment\'s text was not found; it is listed by its ref. Open the result in the portal to read it.');
            }
          }
        }
        for (const r of parsed.results) {
          const comments = r.out['comments'] as CommentOut[] | undefined;
          if (comments !== undefined) {
            r.out['comments'] = comments.map((c) => (c.text !== undefined ? tidy({ ...c, ref: undefined }) : tidy({ ...c })));
          }
        }
        const results = parsed.results.map(finish);
        let status: 'available' | 'not-released' | 'not-found' = 'available';
        let statusNote: string | undefined;
        if (parsed.empty) {
          status = 'not-found';
          statusNote =
            'MyAtriumHealth returned no result for this key. Take the key from mah_list_test_results; ' +
            'a result that has not been released to the patient may also answer this way.';
        } else if (results.length > 0 && results.every((r) => r['released'] === false)) {
          status = 'not-released';
          statusNote =
            'This result has not been released to the patient yet, so its values and report are not ' +
            'available. It appears once the care team releases it.';
        }
        return tidy({
          key,
          status,
          statusNote,
          orderName: parsed.orderName,
          results: parsed.empty ? undefined : results,
          notes: notes.length > 0 ? notes : undefined,
        });
      });
      return envelope({ patient: served.patient, ...served.data });
    },
  );
}
