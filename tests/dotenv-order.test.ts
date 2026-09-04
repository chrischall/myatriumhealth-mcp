import { describe, expect, it, vi } from 'vitest';

/**
 * The priority the server documents: MAH_DOTENV, then ~/.myatriumhealth-mcp/.env,
 * then ./.env.
 *
 * Pinned because the first version of this logic passed an unset MAH_DOTENV
 * through as `undefined`, which is not "skip this candidate" but dotenv's own
 * cwd lookup — so a stray ./.env in whatever directory a client happened to
 * launch from silently won over the state-directory file the ordering exists
 * to prefer. Nothing about the shape of that loop looked wrong.
 */
async function resolveOrder(opts: {
  mahDotenv?: string;
  stateFile: string;
  present: Set<string>;
}): Promise<string[]> {
  const attempts: string[] = [];
  const load = vi.fn(async (o: { path?: string }) => {
    attempts.push(o.path ?? '<cwd>');
    return o.path === undefined ? opts.present.has('<cwd>') : opts.present.has(o.path);
  });

  // The production shape, kept in step with src/index.ts.
  const candidates = [opts.mahDotenv, opts.stateFile].filter(
    (p): p is string => p !== undefined,
  );
  let loaded = false;
  for (const path of candidates) {
    if (await load({ path })) {
      loaded = true;
      break;
    }
  }
  if (!loaded) await load({});
  return attempts;
}

describe('.env lookup order', () => {
  const stateFile = '/home/u/.myatriumhealth-mcp/.env';

  it('prefers the state-directory file over a stray ./.env', async () => {
    const attempts = await resolveOrder({
      stateFile,
      present: new Set([stateFile, '<cwd>']),
    });
    expect(attempts).toEqual([stateFile]);
    expect(attempts).not.toContain('<cwd>');
  });

  it('never treats an unset MAH_DOTENV as the cwd lookup', async () => {
    // The exact defect: an undefined first candidate must be dropped, not
    // forwarded as "no path".
    const attempts = await resolveOrder({ stateFile, present: new Set(['<cwd>']) });
    expect(attempts[0]).toBe(stateFile);
  });

  it('falls back to ./.env only when nothing more specific loads', async () => {
    expect(await resolveOrder({ stateFile, present: new Set(['<cwd>']) })).toEqual([
      stateFile,
      '<cwd>',
    ]);
  });

  it('lets MAH_DOTENV win over both', async () => {
    const explicit = '/etc/mah.env';
    expect(
      await resolveOrder({
        mahDotenv: explicit,
        stateFile,
        present: new Set([explicit, stateFile, '<cwd>']),
      }),
    ).toEqual([explicit]);
  });

  it('tries the next candidate when a more specific one is absent', async () => {
    const explicit = '/etc/mah.env';
    expect(
      await resolveOrder({ mahDotenv: explicit, stateFile, present: new Set([stateFile]) }),
    ).toEqual([explicit, stateFile]);
  });
});
