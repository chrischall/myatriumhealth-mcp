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

/**
 * The endpoints whose field projection was derived from a CAPTURED payload,
 * and the tool that reads each.
 *
 * Declared here so the caller-facing note is generated from it rather than
 * described by hand. The hand-written version of this list was wrong on four
 * of ten entries — it omitted insurance, care team and messages, and credited
 * "visits" when only the past-visits reader projects — which is the specific
 * way documentation about honesty stops being honest. `view.test.ts` checks
 * these keys against the project() call sites in the source.
 */
export const PROJECTED_ENDPOINTS = {
  'allergies/LoadAllergies': 'mah_list_allergies',
  'HealthIssues/LoadHealthIssuesData': 'mah_list_health_issues',
  'immunizations/LoadImmunizations': 'mah_list_immunizations',
  'medications/LoadMedicationsPage': 'mah_list_medications',
  'Clinical/CareTeam/Load': 'mah_list_care_team',
  'goals/LoadPatientGoals': 'mah_list_goals',
  'test-results/GetList': 'mah_list_test_results',
  'Visits/VisitsList/LoadPast': 'mah_list_past_visits',
  'Insurance/Coverages/GetCoverages': 'mah_list_insurance',
  'conversations/GetConversationList': 'mah_list_messages',
} as const;

const PROJECTED_TOOLS = Object.values(PROJECTED_ENDPOINTS).join(', ');

const NOTE =
  'compact strips image/avatar URLs from every response, and on the readers with a projection ' +
  `derived from a captured payload (${PROJECTED_TOOLS}) also reduces each record to its ` +
  'clinically meaningful fields; "full" returns MyAtriumHealth\'s payload untouched. ' +
  'Every other reader gets the URL strip only, rather than a field list nobody verified.';

/** The `view` parameter every read tool in this server takes. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(MAH_VIEWS, { note: NOTE });

/** Whether the caller asked for the reduced rung. The default is `compact`. */
export function isCompact(view: string | undefined): boolean {
  return resolveView(view, MAH_VIEWS) === 'compact';
}

/**
 * Answer in the requested rung.
 *
 * Only ever called from a READ tool. A write's response is a receipt — an id,
 * a status — with nothing to strip and everything to keep.
 */
export function viewResponse(view: string | undefined, data: unknown): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, MAH_VIEWS);
  return minifiedResult(rung === 'compact' ? stripMediaUrls(data) : data);
}
