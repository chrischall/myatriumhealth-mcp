import { createFileStatePersistence, resolveStateFile } from '@chrischall/mcp-utils/session';
import type { MyAtriumHealthClient } from './client.js';
import { listPatients, switchTo, whoAmI, type Patient, type PatientIdentity } from './patients.js';

interface StoredContext {
  patientId: string;
  displayName: string;
}

/**
 * Which patient this connector is reading, held across restarts.
 *
 * Persisted rather than passed per call because the portal models it that way:
 * the active patient lives INSIDE the session cookie, so a per-call parameter
 * would still cost a switch round-trip per call and would still be global to
 * the session while it ran. Storing it makes the connector agree with the
 * portal instead of pretending each read is independent.
 *
 * Its own file, not the auth record: that one is the live cookie jar, and a
 * preference has no business sharing a schema with a credential.
 */
export class PatientContext {
  private readonly store = createFileStatePersistence<StoredContext>({
    filePath: resolveStateFile({
      subdir: '.myatriumhealth-mcp',
      envVar: 'MAH_PATIENT_FILE',
      fileName: 'patient.json',
    }),
    validate: (raw) => {
      const r = raw as Partial<StoredContext> | null;
      return r && typeof r.patientId === 'string' && typeof r.displayName === 'string'
        ? (r as StoredContext)
        : null;
    },
  });

  /** What the portal was last CONFIRMED to be serving, in this process. */
  private applied: string | undefined;

  private desired(): StoredContext | null {
    return this.store.load() ?? null;
  }

  /** Nothing selected means the account holder — the portal's own default. */
  isDefault(): boolean {
    return this.desired() === null;
  }

  async select(client: MyAtriumHealthClient, patient: Patient): Promise<PatientIdentity> {
    const identity = await switchTo(client, patient);
    if (patient.isAccountHolder) {
      // Returning to the default is a CLEARED preference, not a stored one, so
      // an unconfigured connector and a deliberately-reset one behave alike.
      this.store.clear();
    } else {
      this.store.save({ patientId: patient.id, displayName: patient.displayName });
    }
    this.applied = patient.displayName;
    return identity;
  }

  /**
   * Make the session serve the selected patient, and say who that is.
   *
   * Re-asserted rather than assumed because a re-login silently returns the
   * portal to the account holder: the transport replays an expired session
   * without telling anyone, and a reader that trusted its last switch would
   * then label the account holder's chart with a child's name.
   */
  async ensure(client: MyAtriumHealthClient): Promise<string> {
    const want = this.desired();
    if (want === null) {
      this.applied = undefined;
      return (await whoAmI(client)).displayName || 'account holder';
    }
    if (this.applied === want.displayName) return want.displayName;

    const serving = await whoAmI(client);
    if (serving.displayName.trim().toLowerCase() === want.displayName.trim().toLowerCase()) {
      this.applied = want.displayName;
      return want.displayName;
    }
    const patient = (await listPatients(client)).find((p) => p.id === want.patientId);
    if (patient === undefined) {
      this.store.clear();
      this.applied = undefined;
      throw new Error(
        `${want.displayName} is no longer available to this login, so the selection was ` +
          'cleared. Run mah_list_patients to see who is.',
      );
    }
    const identity = await switchTo(client, patient);
    this.applied = identity.displayName;
    return identity.displayName;
  }

  /** Forget the in-process belief, e.g. after the transport re-authenticated. */
  invalidate(): void {
    this.applied = undefined;
  }
}
