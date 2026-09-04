import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MyAtriumHealthAuth } from '../src/auth.js';
import { registerAuthTools } from '../src/tools/auth.js';

const mint = readFileSync(fileURLToPath(new URL('../mint.yaml', import.meta.url)), 'utf8');

/** The tools the server actually registers for the sign-in flow, with their args. */
function authToolSchemas(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const server = {
    registerTool: (name: string, def: { inputSchema?: Record<string, unknown> }) => {
      out[name] = Object.keys(def.inputSchema ?? {});
    },
  } as unknown as Parameters<typeof registerAuthTools>[0];
  registerAuthTools(
    server,
    new MyAtriumHealthAuth({
      credentials: () => ({ username: 'u', password: 'p' }),
      persistence: { load: () => null, save: () => {} },
    }),
  );
  return out;
}

describe('mint.yaml auth flow stays in step with the tools', () => {
  const tools = authToolSchemas();

  // A flow naming a tool the child does not expose, or an argument it does not
  // accept, fails at CONNECT time — in front of the person trying to sign in.
  it('every flow step names a tool the server registers', () => {
    const named = [...mint.matchAll(/- tool: ([a-z_]+)/g)].map((m) => m[1] as string);
    expect(named.length).toBeGreaterThan(0);
    for (const t of named) expect(Object.keys(tools)).toContain(t);
  });

  it('every flow argument is accepted by the tool it is passed to', () => {
    // Indentation-independent on purpose. The first version of this matched
    // `^\s{10}` and split on a literal "\n      - tool:", so reformatting the
    // YAML would have made it check ZERO arguments and still pass — the same
    // vacuous-pass shape as the earlier `[a-z]+` bug, which caught a typo'd
    // tool name while silently ignoring a camelCase wrong argument.
    const steps = [...mint.matchAll(/- tool:\s*([a-z_]+)([\s\S]*?)(?=\n\s*- tool:|\n\s*capture:|$)/g)];
    expect(steps.length).toBeGreaterThan(0);

    let checked = 0;
    for (const [, tool, body] of steps) {
      for (const [, arg] of (body as string).matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*):\s*\{\s*from:/gm)) {
        expect(tools[tool as string], `${tool} accepts ${arg}`).toContain(arg);
        checked++;
      }
    }
    // The anti-vacuity guard. Without it this whole test passes by matching
    // nothing, which is precisely how a drift guard stops guarding.
    expect(checked, 'no flow arguments were checked — the parse matched nothing').toBeGreaterThanOrEqual(2);
  });

  it('offers only channels the send tool accepts', () => {
    const offered = [...mint.matchAll(/- \{ value: ([a-z]+), label:/g)].map((m) => m[1] as string);
    expect(offered).toEqual(expect.arrayContaining(['sms', 'email']));
    // totp is deliberately absent: nothing is sent for an authenticator app.
    expect(offered).not.toContain('totp');
  });

  it('declares per-user children, which auth requires', () => {
    expect(mint).toMatch(/perUserChild:\s*true/);
    expect(mint).toMatch(/dataDir:\s*true/);
  });

  it('does not name a host-set variable as an auth field', () => {
    const envNames = [...mint.split('identity:')[0].matchAll(/- name: ([A-Z_]+)/g)].map((m) => m[1]);
    const fieldNames = [...mint.split('fields:')[1].matchAll(/- name: ([A-Z_]+)/g)].map((m) => m[1]);
    expect(envNames.filter((n) => fieldNames.includes(n as string))).toEqual([]);
  });
});
