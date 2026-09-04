import { McpToolError } from '@chrischall/mcp-utils';
import { matchBalanced } from '@chrischall/mcp-utils/scrape';
import type { MyAtriumHealthClient } from './client.js';

/**
 * A patient this login can open — the account holder, or someone who has given
 * them proxy access.
 *
 * [id] is deliberately the subject's `WPRINTERNAL` identifier and nothing else.
 * The portal publishes seventeen id types per subject and only that one is
 * accepted by the switcher: every other type returns the same HTTP 302 and
 * silently leaves the context where it was, which is the worst possible
 * failure — a switch that looks like it worked and serves the wrong chart.
 * Measured across all seventeen (docs/MYATRIUMHEALTH-API.md, "Patient switching").
 */
export interface Patient {
  id: string;
  displayName: string;
  /** The signed-in account itself, rather than someone who granted proxy access. */
  isAccountHolder: boolean;
  relationship: 'self' | 'proxy';
}

/** What the portal says it is serving right now, asked rather than assumed. */
export interface PatientIdentity {
  displayName: string;
  age: number | null;
}

/**
 * Read the switcher's own list out of a signed-in page.
 *
 * The portal ships it as `EpicPx.ReactContext.personalizations.proxySubjects
 * .push({...})` calls in the HTML, not as an API — there is no endpoint that
 * lists them, so this is the source the switcher itself uses.
 */
export function parseProxySubjects(html: string): Patient[] {
  const out: Patient[] = [];
  for (const m of html.matchAll(/personalizations\.proxySubjects\.push\(\s*\{/g)) {
    const start = html.indexOf('{', m.index + m[0].length - 1);
    // The library walk rather than a depth counter: it is STRING-AWARE, so a
    // brace inside a quoted value — a display name, an id — ends the object
    // where the object actually ends rather than where the first unmatched `}`
    // happens to fall.
    const end = matchBalanced(html, start);
    if (end === -1) continue;
    const blob = html.slice(start, end + 1);
    const displayName = /displayName:"([^"]*)"/.exec(blob)?.[1];
    const ids = new Map<string, string>();
    for (const p of blob.matchAll(/type:"([A-Z]+)",value:"([^"]*)"/g)) ids.set(p[1], p[2]);
    const id = ids.get('WPRINTERNAL');
    if (displayName === undefined || id === undefined) continue;
    // The account holder is the only subject carrying a MYCHARTLOGIN id: proxy
    // subjects have no login of their own through this account.
    const isAccountHolder = ids.has('MYCHARTLOGIN');
    out.push({
      id,
      displayName,
      isAccountHolder,
      relationship: isAccountHolder ? 'self' : 'proxy',
    });
  }
  return out;
}

/** Ask the portal who it is currently serving. One call, and it cannot be faked. */
export async function whoAmI(client: MyAtriumHealthClient): Promise<PatientIdentity> {
  const r = (await client.api('health-summary/FetchHealthSummary')) as {
    patientFirstName?: string;
    header?: { patientAge?: number };
  };
  return {
    displayName: r?.patientFirstName ?? '',
    age: typeof r?.header?.patientAge === 'number' ? r.header.patientAge : null,
  };
}

export async function listPatients(client: MyAtriumHealthClient): Promise<Patient[]> {
  const patients = parseProxySubjects(await client.page('Home'));
  if (patients.length === 0) {
    throw new McpToolError('Could not read the patient list from MyAtriumHealth.', {
      hint:
        'The switcher list is parsed out of the signed-in Home page. If the session is ' +
        'live but this is empty, the portal markup may have changed — run mah_healthcheck.',
    });
  }
  return patients;
}

/**
 * Point the session at a patient and CONFIRM it landed.
 *
 * The confirmation is the point. The switcher answers 302 whether or not it
 * understood the id, so the only way to know a switch happened is to ask the
 * portal who it is serving afterwards.
 */
export async function switchTo(
  client: MyAtriumHealthClient,
  patient: Patient,
  expected?: PatientIdentity,
): Promise<PatientIdentity> {
  await client.page(
    `ProxySwitch/SwitchContext?eaccountid=${encodeURIComponent(patient.id)}&redirecturl=Home`,
  );
  const now = await whoAmI(client);
  // Name AND age when an age is known, because the portal publishes only a
  // FIRST name: two subjects called "Sam" would otherwise let a switch that
  // did nothing confirm as success. Two subjects sharing a first name AND an
  // age remain indistinguishable from this signal alone.
  const ok = expected === undefined
    ? sameName(now.displayName, patient.displayName)
    : sameIdentity(now, expected);
  if (!ok) {
    throw new McpToolError(
      `MyAtriumHealth did not switch to ${patient.displayName}; it is still serving ` +
        `${now.displayName || 'an unknown patient'}.`,
      {
        hint:
          'Proxy access may have been withdrawn, or it may need re-verification. Run ' +
          'mah_list_patients to see what this login can still open.',
      },
    );
  }
  return now;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Same person, as far as the portal will tell us: first name plus age. */
export function sameIdentity(a: PatientIdentity, b: PatientIdentity): boolean {
  if (!sameName(a.displayName, b.displayName)) return false;
  if (a.age === null || b.age === null) return true;
  return a.age === b.age;
}
