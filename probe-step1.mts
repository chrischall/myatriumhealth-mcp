import { makeAuth, savedAt } from './rotation-probe.mjs';
const auth = makeAuth();
try {
  const r = await auth.login();
  console.log(JSON.stringify({ challenge: false, signedIn: r, jarSavedAt: savedAt() }, null, 2));
} catch (e: any) {
  console.log(JSON.stringify({
    challenge: true,
    channels: e.methods ?? e.channels ?? null,
    maskedEmail: e.email ?? null,
    maskedPhone: e.phone ?? null,
    message: e.message,
    jarSavedAt: savedAt(),
  }, null, 2));
}
process.exit(0);
