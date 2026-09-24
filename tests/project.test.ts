import { afterEach, describe, expect, it, vi } from 'vitest';
import { project } from '../src/tools/_project.js';

// Synthetic record: obviously fake values, never real PHI.
const drifted = {
  renamedList: [{ patientName: 'Test Patient', mrn: 'MRN-000', diagnosis: 'Example condition' }],
  ssnLast4: '0000',
};

const pickList = (r: { list?: { name: string }[] }) => r.list?.map((x) => ({ name: x.name }));

describe('project() when the expected shape is missing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not hand the raw portal record back on the compact rung', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = project(drifted, true, 'medications/LoadMedicationsPage', pickList as never);
    const text = JSON.stringify(out);
    expect(text).not.toContain('Test Patient');
    expect(text).not.toContain('MRN-000');
    expect(text).not.toContain('Example condition');
    expect(text).not.toContain('0000');
    expect(out).toMatchObject({ projectionFailed: true, endpoint: 'medications/LoadMedicationsPage' });
  });

  it("tells the caller to ask for view:'full' explicitly, naming the tool", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = project(drifted, true, 'medications/LoadMedicationsPage', pickList as never) as {
      note: string;
    };
    expect(out.note).toContain("view: 'full'");
    expect(out.note).toContain('mah_list_medications');
  });

  it('reports only the top-level key names, so drift is diagnosable without values', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = project(drifted, true, 'medications/LoadMedicationsPage', pickList as never);
    expect(out).toMatchObject({ topLevelKeys: ['renamedList', 'ssnLast4'] });
  });

  it('treats a throwing pick the same way', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = project(drifted, true, 'allergies/LoadAllergies', (() => {
      throw new Error('boom');
    }) as never);
    expect(JSON.stringify(out)).not.toContain('Test Patient');
    expect(out).toMatchObject({ projectionFailed: true });
  });

  it('keeps the stderr warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    project(drifted, true, 'medications/LoadMedicationsPage', pickList as never);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('medications/LoadMedicationsPage'));
  });

  it("still returns the raw payload untouched when the caller asked for view:'full'", () => {
    expect(project(drifted, false, 'medications/LoadMedicationsPage', pickList as never)).toBe(drifted);
  });

  it('still projects when the shape is present', () => {
    expect(project({ list: [{ name: 'A', extra: 1 }] }, true, 'x', pickList as never)).toEqual([{ name: 'A' }]);
  });
});
