/**
 * Projection helper for the reverse-engineered listing endpoints.
 *
 * These envelopes are large (test results 33 KB, medications 30 KB) and mostly
 * UI plumbing. `compact` projects each record to the clinically meaningful
 * fields. Undocumented APIs drift, so when the expected shape is absent we
 * WARN to stderr and return the RAW response rather than an empty projection —
 * degrade, never break.
 */
export function project<T>(
  raw: unknown,
  compact: boolean,
  endpoint: string,
  pick: (raw: never) => T[] | undefined,
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
      `[myatriumhealth-mcp] ${endpoint}: expected shape missing — returning the raw response. ` +
        'The portal may have changed; see docs/MYATRIUMHEALTH-API.md.',
    );
    return raw;
  }
  return out;
}

/** Drop keys whose value is null/undefined/'' so compact output stays compact. */
export function tidy<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out as Partial<T>;
}
