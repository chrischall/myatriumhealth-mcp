import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECTED_ENDPOINTS, isCompact, viewArg } from '../src/view.js';

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools');

/** Every endpoint the source actually passes to project(). */
function projectingEndpoints(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(TOOLS).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(TOOLS, file), 'utf8');
    for (const m of src.matchAll(/project\(\s*raw,\s*isCompact\(view\),\s*'([^']+)'/g)) {
      found.push(m[1]);
    }
  }
  return found.sort();
}

describe('the projected-endpoint list', () => {
  it('matches the project() call sites exactly', () => {
    // The defect this exists for: the caller-facing note listed which readers
    // reduce records to a verified field list, and the hand-written version was
    // wrong on four of ten — it omitted insurance, care team and messages, and
    // credited "visits" when only the past-visits reader projects. A note about
    // what has been verified is the last place to state something unverified.
    expect(projectingEndpoints()).toEqual(Object.keys(PROJECTED_ENDPOINTS).sort());
  });

  it('names every projecting endpoint in the note callers actually read', () => {
    const note = viewArg().description ?? '';
    for (const tool of Object.values(PROJECTED_ENDPOINTS)) {
      expect(note, `${tool} missing from the view note`).toContain(tool);
    }
  });

  it('does not credit a reader that only strips URLs', () => {
    // mah_list_upcoming_visits reads a different endpoint and runs no
    // projection; claiming otherwise oversells what compact does for it.
    expect(Object.values(PROJECTED_ENDPOINTS)).not.toContain('mah_list_upcoming_visits');
    expect(projectingEndpoints()).not.toContain('Visits/VisitsList/LoadUpcoming');
  });
});

describe('rung resolution', () => {
  it('treats an unspecified view as compact, which is the documented default', () => {
    expect(isCompact(undefined)).toBe(true);
  });

  it('honours an explicit full', () => {
    expect(isCompact('full')).toBe(false);
    expect(isCompact('compact')).toBe(true);
  });
});
