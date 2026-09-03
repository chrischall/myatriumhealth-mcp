import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MyAtriumHealthClient } from '../src/client.js';
import type { MahTransport } from '../src/transport.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerRecordTools } from '../src/tools/records.js';
import { registerResultTools } from '../src/tools/results.js';
import { registerVisitTools } from '../src/tools/visits.js';

const stubTransport: MahTransport = {
  start: async () => {},
  close: async () => {},
  fetch: async () => ({ status: 200, body: '' }),
};

/** The roster, minus mah_healthcheck (which needs the concrete transport). */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  } as unknown as Parameters<typeof registerRecordTools>[0];
  const client = new MyAtriumHealthClient({ transport: stubTransport });
  registerRecordTools(server, client);
  registerResultTools(server, client);
  registerVisitTools(server, client);
  registerAccountTools(server, client);
  return names;
}

const manifestTools = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'),
  ) as { tools: { name: string; description: string }[] }
).tools;

describe('tool roster', () => {
  it('registers the expected tools', () => {
    expect(registeredToolNames().sort()).toEqual([
      'mah_get_health_summary',
      'mah_get_menu',
      'mah_list_allergies',
      'mah_list_goals',
      'mah_list_health_issues',
      'mah_list_immunizations',
      'mah_list_insurance',
      'mah_list_medications',
      'mah_list_message_folders',
      'mah_list_messages',
      'mah_list_past_visits',
      'mah_list_test_results',
      'mah_list_upcoming_visits',
    ]);
  });

  // Both directions. A tool registered but absent from manifest.json is
  // callable by name yet invisible to an mcpb host, and nothing else reads
  // that file — so only this assertion catches it.
  it('manifest.json lists every registered tool', () => {
    const registered = new Set([...registeredToolNames(), 'mah_healthcheck']);
    const listed = new Set(manifestTools.map((t) => t.name));
    expect([...registered].filter((n) => !listed.has(n)), 'registered but not in manifest').toEqual([]);
    expect([...listed].filter((n) => !registered.has(n)), 'in manifest but not registered').toEqual([]);
  });

  it('gives every manifest tool a real description', () => {
    for (const t of manifestTools) {
      expect(t.description?.trim().length, `${t.name} has no description`).toBeGreaterThan(10);
    }
  });
});
