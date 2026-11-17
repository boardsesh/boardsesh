import { setPasswordMode } from '@boardsesh/auth-protocol';
import { identityMirrorMode } from './mirror-configuration';
import { assertIdentityCopyGates } from './identity-copy-gates';
import { assertAuthorityActivationGates } from './activation-gates';
import { currentStoreAuthorityConfiguration } from '../current-store/authority-configuration';
import { credentialDatabaseConfiguration } from '../credential-database-configuration';
import { openCredentialPool, qualifyCredentialPool } from '../credential-database';
import {
  IdentityCopyPreconditionError,
  assertIdentityCopyTables,
  readIdentityCopySnapshot,
  writerQualificationRefusal,
  type IdentityCopyAuthority,
} from './identity-copy-preconditions';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * `qualified`: every precondition held at boot; copies are checked against this
 * projection and epoch. `inert`: the database's epoch is ahead of the deployed
 * configuration, the signature of an authority switch after this deployment was
 * configured. The process serves, the mirror copies nothing, and every mirrored
 * credential write refuses until a redeploy with the mirror off or the new epoch.
 */
export type IdentityMirrorState =
  | { readonly state: 'qualified'; readonly authority: IdentityCopyAuthority }
  | { readonly state: 'inert'; readonly reason: 'AUTHORITY_NOT_CURRENT_STORE' | 'AUTHORITY_STALE' };

let recorded: IdentityMirrorState | { readonly state: 'function-level' } | undefined;

/** What this process recorded at startup; `undefined` means it never qualified. */
export function identityMirrorRecord(): IdentityMirrorState | { readonly state: 'function-level' } | undefined {
  return recorded;
}

/**
 * Test suites that select `AUTH_IDENTITY_MIRROR=on` to exercise writers without
 * booting the backend. Their copies keep the unqualified behaviour (no phase or
 * epoch check). Production never calls this; sync-identity.test.ts fails if a
 * non-test module does.
 */
export function recordFunctionLevelIdentityMirrorForTests(): void {
  recorded = Object.freeze({ state: 'function-level' as const });
}

/** Configuration the backend itself must carry for every identity writer to mirror. */
function mirrorConfiguration(environment: Environment): IdentityCopyAuthority {
  try {
    // With mirroring selected this returns only the delegated backend-staging mode.
    setPasswordMode(environment);
  } catch {
    throw new IdentityCopyPreconditionError('SET_PASSWORD_NOT_DELEGATED');
  }
  // Legacy native registration and OAuth cannot take the gate and user lock in order.
  if (
    environment.CURRENT_STORE_NATIVE_REGISTRATION_MODE !== 'reserved-staging' ||
    environment.CURRENT_STORE_NATIVE_OAUTH_MODE !== 'reserved-staging'
  )
    throw new IdentityCopyPreconditionError('NATIVE_WRITERS_NOT_STAGED');
  try {
    const authority = currentStoreAuthorityConfiguration(environment);
    return { projectionId: authority.expectedProjectionId, epoch: authority.expectedWriterEpoch };
  } catch {
    throw new IdentityCopyPreconditionError('AUTHORITY_CONFIGURATION_INVALID');
  }
}

/**
 * Called once in `main()` before the job queue or the server starts.
 * `AUTH_IDENTITY_MIRROR=off` (the default) returns at once with no query. `on`
 * checks, in order, and throws one fixed code on the first that fails:
 *
 * 1. Configuration: delegated set-password, staged native writers, a valid
 *    expected projection and epoch.
 * 2. On the dedicated credential LOGIN: the mirror's tables exist, and the LOGIN
 *    qualifies (reviewed grants and relation shapes, same server and database
 *    as the content pool).
 * 3. One read-only snapshot: the manifest is enforced and the web fence verifies.
 * 4. The manifest is the configured projection, at the configured epoch, with
 *    current-store as the writer authority. An epoch ahead of the configured one
 *    boots inert instead (see {@link IdentityMirrorState}); anything else refuses.
 * 5. The code gates in identity-copy-gates.ts, then activate's own in
 *    activation-gates.ts (ACTIVATION_CODE_GATES_OPEN).
 *
 * "Could not check" (a lost connection, a timeout) is PRECONDITION_CHECK_UNAVAILABLE,
 * never a verdict. The fence and the LOGIN's grants are not re-read per
 * transaction; a grant change after boot is caught by the next boot and by
 * `auth-fence`. The manifest is re-read by every copy.
 */
export async function qualifyIdentityMirrorAtStartup(
  environment: Environment = process.env,
): Promise<IdentityMirrorState | undefined> {
  recorded = undefined;
  let mode: 'off' | 'on';
  try {
    mode = identityMirrorMode(environment);
  } catch {
    throw new IdentityCopyPreconditionError('MIRROR_SELECTOR_INVALID');
  }
  if (mode === 'off') return undefined;
  const expected = mirrorConfiguration(environment);
  let configuration: ReturnType<typeof credentialDatabaseConfiguration>;
  try {
    configuration = credentialDatabaseConfiguration(environment);
  } catch {
    throw new IdentityCopyPreconditionError('CREDENTIAL_WRITER_UNQUALIFIED');
  }
  const pool = openCredentialPool(configuration, 1);
  try {
    await assertIdentityCopyTables(pool);
    await qualifyCredentialPool(pool, configuration).catch((error: unknown) => {
      throw writerQualificationRefusal(error);
    });
    const snapshot = await readIdentityCopySnapshot(pool);
    if (snapshot.projectionId !== expected.projectionId || snapshot.epoch < expected.epoch)
      throw new IdentityCopyPreconditionError('AUTHORITY_STALE');
    if (snapshot.epoch > expected.epoch) {
      recorded = Object.freeze({
        state: 'inert' as const,
        reason:
          snapshot.authority === 'current-store'
            ? ('AUTHORITY_STALE' as const)
            : ('AUTHORITY_NOT_CURRENT_STORE' as const),
      });
      return recorded;
    }
    if (snapshot.authority !== 'current-store') throw new IdentityCopyPreconditionError('AUTHORITY_NOT_CURRENT_STORE');
    assertIdentityCopyGates();
    // `enforced` can be set by hand; activate's own gates must have closed too.
    assertAuthorityActivationGates();
    recorded = Object.freeze({ state: 'qualified' as const, authority: Object.freeze({ ...expected }) });
    return recorded;
  } finally {
    // A failed close must not replace the refusal code with driver text.
    await pool.end({ timeout: 5 }).catch(() => undefined);
  }
}
