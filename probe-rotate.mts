import { makeAuth, snapshot, savedAt } from './rotation-probe.mjs';

const CODE = process.argv[2];
const auth = makeAuth();

function diff(a: Record<string,string>, b: Record<string,string>) {
  const changed: string[] = [], added: string[] = [], dropped: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) added.push(k);
    else if (!(k in b)) dropped.push(k);
    else if (a[k] !== b[k]) changed.push(k);
  }
  return { changed, added, dropped };
}

async function main() {
  try { await auth.login(); } catch { /* challenge expected */ }
  await auth.verifyCode(CODE);
  console.log('verified. jar savedAt =', savedAt());

  let prev = snapshot(auth);
  console.log('cookies at sign-in:', Object.keys(prev).length);

  // Real reads a user would make, spaced out, through the same egress.
  const paths = ['Home', 'Home', 'scheduling/upcoming', 'Home',
                 'inside.asp?mode=medications', 'Home'];
  for (let i = 0; i < paths.length; i++) {
    await auth.request(paths[i]);
    auth.persistIfDirty();
    const now = snapshot(auth);
    const d = diff(prev, now);
    const moved = d.changed.length || d.added.length || d.dropped.length;
    console.log(`#${i + 1} GET ${paths[i]} -> ${moved ? JSON.stringify(d) : 'no cookie changed'}`
      + (moved ? `  savedAt=${savedAt()}` : ''));
    prev = now;
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log('final savedAt =', savedAt());
  process.exit(0);
}
main().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
