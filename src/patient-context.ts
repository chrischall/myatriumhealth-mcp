import { createFileStatePersistence, resolveStateFile } from '@chrischall/mcp-utils/session';
import type { MyAtriumHealthClient } from './client.js';
import { McpToolError } from '@chrischall/mcp-utils';
import {
  listPatients,
  sameIdentity,
  switchTo,
  whoAmI,
  type Patient,
  type PatientIdentity,
} from './patients.js';

interface StoredContext {
  patientId: string;
  displayName: string;
  /** Learned on selection. A second discriminator: the portal gives first names only. */
  age: number | null;
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
  /**
   * Whether something will TELL us a new session began.
   *
   * True only in bridge-less mode, where [MyAtriumHealthAuth] announces every
   * sign-in. Through the browser bridge nothing can: the session lives in the
   * user's own tab, they may switch patients in it themselves, and no event
   * reaches this process — so there the confirmation is repeated per read
   * rather than cached, because a cache nothing can invalidate is a
   * process-lifetime claim about someone's medical records.
   */
  constructor(private readonly sessionChangesAnnounced = false) {}

  private readonly store = createFileStatePersistence<StoredContext>({
    filePath: resolveStateFile({
      subdir: '.myatriumhealth-mcp',
      envVar: 'MAH_PATIENT_FILE',
      fileName: 'patient.json',
    }),
    validate: (raw) => {
      const r = raw as Partial<StoredContext> | null;
      return r && typeof r.patientId === 'string' && typeof r.displayName === 'string'
        ? ({ ...r, age: typeof r.age === 'number' ? r.age : null } as StoredContext)
        : null;
    },
  });

  /**
   * What the portal was last CONFIRMED to be serving in this process.
   *
   * Safe to trust only because [invalidate] is wired to the transport's
   * re-authentication: a fresh sign-in silently returns the portal to the
   * account holder, and without that wiring this cache is exactly the bug it
   * looks like — one patient's chart labelled with another's name.
   */
  private applied: PatientIdentity | undefined;

  /** Bumped by [invalidate]. Lets a read notice a sign-in that happened mid-flight. */
  private generation = 0;

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
      this.store.save({
        patientId: patient.id,
        displayName: patient.displayName,
        age: identity.age,
      });
    }
    this.applied = identity;
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

    // One confirmation per session, not per read. The cache is cleared on
    // re-authentication, so a connector that never switches patients pays a
    // single FetchHealthSummary rather than one per tool call.
    if (this.sessionChangesAnnounced && this.applied !== undefined) {
      if (want === null || sameIdentity(this.applied, { displayName: want.displayName, age: want.age })) {
        // Same fallback as the uncached branch, or a summary without a first
        // name labels the first read "account holder" and every later one "".
        return this.applied.displayName || 'account holder';
      }
    }

    const serving = await whoAmI(client);
    if (want === null) {
      this.applied = serving;
      return serving.displayName || 'account holder';
    }
    if (sameIdentity(serving, { displayName: want.displayName, age: want.age })) {
      this.applied = serving;
      return serving.displayName;
    }

    const patient = (await listPatients(client)).find((p) => p.id === want.patientId);
    if (patient === undefined) {
      this.store.clear();
      this.applied = undefined;
      throw new McpToolError(
        `${want.displayName} is no longer available to this login, so the selection was cleared.`,
        { hint: 'Run mah_list_patients to see who this login can open, then select one.' },
      );
    }
    const identity = await switchTo(client, patient, {
      displayName: want.displayName,
      age: want.age,
    });
    this.applied = identity;
    return identity.displayName;
  }

  /** Forget the in-process belief, e.g. after a new session was established. */
  invalidate(): void {
    this.applied = undefined;
    this.generation++;
  }

  /**
   * Run a read and label it with the patient it ACTUALLY came from.
   *
   * Confirming before the read is not enough. The transport replays an expired
   * session by signing in again, which returns the portal to the account
   * holder — so the very read being labelled can be the one that resets the
   * context, and it would come back as the account holder's chart under the
   * selected patient's name. Instead the session generation is captured before
   * the read and checked after: if a sign-in happened in between, the context
   * is re-applied and the read is taken again.
   *
   * Once. A second disagreement means something is resetting the context
   * faster than it can be used, and returning data whose owner cannot be
   * established is the one outcome worth refusing.
   */
  async readAs<T>(
    client: MyAtriumHealthClient,
    read: () => Promise<T>,
  ): Promise<{ patient: string; data: T }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const patient = await this.ensure(client);
      const generation = this.generation;
      const data = await read();
      if (this.generation === generation) return { patient, data };
    }
    throw new McpToolError(
      'MyAtriumHealth re-authenticated while reading, so the patient this data belongs ' +
        'to could not be established.',
      { hint: 'Run mah_get_patient_context, then retry the read.' },
    );
  }
}
