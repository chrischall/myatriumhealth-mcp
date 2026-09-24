/**
 * Projection helper for the reverse-engineered listing endpoints.
 *
 * These envelopes are large (test results 33 KB, medications 30 KB) and mostly
 * UI plumbing. `compact` projects each record to the clinically meaningful
 * fields. Undocumented APIs drift, so when the expected shape is absent we
 * WARN to stderr and return a flagged {@link ProjectionFailure} rather than an
 * empty projection — degrade, never break. It deliberately does NOT fall back
 * to the raw response: that would dump every field of a health record into the
 * transcript on the rung whose whole job is to keep them out, silently and for
 * every tool at once. The caller gets the key names (no values) and is told to
 * ask for `view: 'full'` explicitly if it needs the payload.
 */
import { PROJECTED_ENDPOINTS } from '../view.js';

/** What compact returns when the portal's shape no longer matches the projection. */
export interface ProjectionFailure {
  projectionFailed: true;
  endpoint: string;
  /** Top-level key names only, never values, so drift is diagnosable. */
  topLevelKeys?: string[];
  note: string;
}

function projectionFailure(raw: unknown, endpoint: string): ProjectionFailure {
  const tool = (PROJECTED_ENDPOINTS as Record<string, string>)[endpoint];
  const again = tool ? `call ${tool} again with view: 'full'` : "call again with view: 'full'";
  const out: ProjectionFailure = {
    projectionFailed: true,
    endpoint,
    note:
      'The portal response no longer matches the expected shape, so the compact projection ' +
      `could not be applied and the record was withheld. To see the portal's payload, ${again}.`,
  };
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    out.topLevelKeys = Object.keys(raw);
  }
  return out;
}
/**
 * Whether a paged endpoint returned everything. A bare array reads as the
 * whole history, so a reader whose endpoint pages says so alongside it.
 */
export interface Completeness {
  /** The portal's own flag; absent when it did not say. */
  complete?: boolean;
  /** What is missing and how to get it, when something is. */
  note?: string;
}

export function project<T>(
  raw: unknown,
  compact: boolean,
  endpoint: string,
  pick: (raw: never) => T[] | undefined,
  completeness?: (raw: never) => Completeness,
): unknown {
  if (!compact) return raw;
  let out: T[] | undefined;
  try {
    out = pick(raw as never);
  } catch {
    out = undefined;
  }
  if (out === undefined) {
    console.error(
      `[myatriumhealth-mcp] ${endpoint}: expected shape missing — withholding the record; ` +
        "view: 'full' returns it raw. The portal may have changed; see docs/MYATRIUMHEALTH-API.md.",
    );
    return projectionFailure(raw, endpoint);
  }
  if (completeness === undefined) return out;
  // Returned as { items, complete, note } rather than a bare array: the flags
  // are the only thing telling a first page from the whole history.
  let c: Completeness = {};
  try {
    c = completeness(raw as never);
  } catch {
    c = {};
  }
  return tidy({ items: out, complete: c.complete, note: c.note });
}

/** Drop keys whose value is null/undefined/'' so compact output stays compact. */
export function tidy<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out as Partial<T>;
}
