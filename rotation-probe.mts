// Investigation: does MyChart rotate any cookie mid-session?
// Prints cookie NAMES and short digests of values — never a value itself.
import { MyAtriumHealthAuth } from './src/auth.js';
import { createFileStatePersistence } from '@chrischall/mcp-utils/session';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const FILE = homedir() + '/.myatriumhealth-mcp/device.json';
export function env(name: string): string {
  const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim() : '';
}
export function makeAuth() {
  const username = env('MAH_USERNAME');
  return new MyAtriumHealthAuth({
    credentials: () => ({ username, password: env('MAH_PASSWORD') }),
    persistence: createFileStatePersistence({
      filePath: FILE,
      boundTo: username,
      validate: (raw: any) =>
        raw && typeof raw.deviceId === 'string' && typeof raw.username === 'string' ? raw : null,
    }),
  });
}
/** name -> 8-char digest. Values are hashed, never shown. */
export function snapshot(auth: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of auth.jar) out[k] = createHash('sha256').update(String(v)).digest('hex').slice(0, 8);
  return out;
}
export function savedAt(): string {
  try { return new Date(JSON.parse(readFileSync(FILE, 'utf8')).state.savedAt).toISOString(); }
  catch { return 'none'; }
}
