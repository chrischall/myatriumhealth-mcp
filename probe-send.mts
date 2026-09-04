import { makeAuth } from './rotation-probe.mjs';
const auth = makeAuth();
try {
  // Re-detect so the challenge context/antiforgery token is fresh.
  try { await auth.login(); } catch { /* expected: challenge */ }
  const r = await auth.sendCode('sms');
  console.log(JSON.stringify({ sent: r, channel: 'sms' }, null, 2));
} catch (e: any) {
  console.log(JSON.stringify({ error: e.message }, null, 2));
}
process.exit(0);
