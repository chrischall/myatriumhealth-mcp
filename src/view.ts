import { minifiedResult, resolveView, stripMediaUrls, viewParam, type View } from '@chrischall/mcp-utils';

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * **What compact does here, and what it deliberately does NOT do.**
 *
 * The read tools in this server hand back MyAtriumHealth's payload close to
 * verbatim, and the repo holds no verified record of what those payloads
 * contain — no captured fixture, no documented field list. So nothing here can
 * honestly say which of MyAtriumHealth's fields matter and which are noise.
 *
 * Compact therefore always does the one projection that needs no such
 * knowledge: it strips image and avatar URLs. That is SUBTRACTIVE, so it cannot
 * lose a field nobody knew about — the failure an invented field list would
 * risk, where a record comes back with holes in it and reads like a verified
 * answer.
 *
 * Several listing endpoints DO have a projection that was derived from their
 * real payloads ({@link project}), and for those compact reduces each record to
 * those fields as well. The distinction is deliberate: a field list is applied
 * only where one was actually established, never inferred.
 */
export const MAH_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact strips image/avatar URLs, and on the listing endpoints with a verified projection ' +
  '(allergies, health issues, immunizations, medications, goals, test results, visits) also reduces each ' +
  'record to its clinically meaningful fields; "full" returns MyAtriumHealth\'s payload untouched. ' +
  'Where no verified projection exists, compact only strips URLs rather than inventing a field list.';

/** The `view` parameter every read tool in this server takes. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(MAH_VIEWS, { note: NOTE });

/**
 * Answer in the requested rung.
 *
 * Only ever called from a READ tool. A write's response is a receipt — an id,
 * a status — with nothing to strip and everything to keep.
 */
/** Whether the caller asked for the reduced rung. The default is `compact`. */
export function isCompact(view: string | undefined): boolean {
  return resolveView(view, MAH_VIEWS) === 'compact';
}

export function viewResponse(view: string | undefined, data: unknown): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, MAH_VIEWS);
  return minifiedResult(rung === 'compact' ? stripMediaUrls(data) : data);
}
