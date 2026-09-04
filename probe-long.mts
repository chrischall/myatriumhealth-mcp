// Keeps the session gently active and watches for two things at once:
//   1. does any cookie value ever change (rotation / sliding ticket reissue)?
//   2. does an ACTIVE session outlive the ~3.6h an idle one did?
// Logs cookie NAMES and digests only — never a value.
import { makeAuth, snapshot, savedAt } from './rotation-probe.mjs';
import { appendFileSync } from 'node:fs';

const LOG = '/tmp/mah-session-watch.log';
const INTERVAL_MS = 3 * 60 * 1000;
const MAX_MIN = 300; // 5h — comfortably past the 219-min idle death

function say(line: string) {
  const stamp = new Date().toISOString();
  appendFileSync(LOG, `${stamp}  ${line}\n`);
  console.log(`${stamp}  ${line}`);
}

async function main() {
  const auth = makeAuth();
  const started = Date.now();
  let prev = snapshot(auth);
  say(`start: ${Object.keys(prev).length} cookies, savedAt=${savedAt()}`);

  for (let i = 1; ; i++) {
    const ageMin = Math.round((Date.now() - started) / 60000);
    if (ageMin > MAX_MIN) { say(`STOP: reached ${MAX_MIN} min still signed in`); break; }
    try {
      const { body } = await auth.request('Home');
      const dead = /<title>[^<]*Login Page/i.test(body);
      auth.persistIfDirty();
      const now = snapshot(auth);
      const changed = Object.keys(now).filter((k) => prev[k] !== now[k]);
      const gone = Object.keys(prev).filter((k) => !(k in now));
      const fresh = Object.keys(now).filter((k) => !(k in prev));
      if (dead) { say(`DEAD at +${ageMin}min — active session ended (poll #${i})`); break; }
      if (changed.length || gone.length || fresh.length) {
        say(`ROTATED at +${ageMin}min: changed=[${changed}] new=[${fresh}] gone=[${gone}] savedAt=${savedAt()}`);
      } else if (i % 5 === 0) {
        say(`+${ageMin}min alive, no rotation (poll #${i})`);
      }
      prev = now;
    } catch (e: any) {
      say(`ERROR at +${ageMin}min: ${e.message}`);
      break;
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  process.exit(0);
}
main();
