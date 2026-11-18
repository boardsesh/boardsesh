import { authEmailProjection, users } from '@boardsesh/db/schema';
import { eq } from 'drizzle-orm';
import type { createNativeHttpFixture } from './http-fixture';

type Fixture = Awaited<ReturnType<typeof createNativeHttpFixture>>;
type Environment = Record<string, string>;

/**
 * What the identity manifest says while a cell runs. `none` is production
 * today. `current-store` and `better-auth` are an enforced manifest naming that
 * writer; `better-auth` is the new authority the facade has to front.
 */
export type ManifestState = 'none' | 'current-store' | 'better-auth';

export interface ServerMode {
  readonly name: string;
  readonly manifest: ManifestState;
  /** Selector values; every selector not named is unset, which is legacy/off. */
  readonly selectors: Environment;
  /**
   * AUTH_NATIVE_REVOCATION_MODE=generation. The Garmin activation blocker in
   * native-revocation-configuration.ts refuses it at startup and on every
   * revoke/refresh, so the cell replaces only that lookup inside the test,
   * the way native-ancestry.contract.ts qualifies the canonical core.
   */
  readonly generation: boolean;
  /** The startup guards production runs (index.ts), on this cell's selectors. */
  readonly startup: 'boots' | readonly string[];
}

/** One projection the whole file prepares, enforces and later switches. */
export const PROJECTION_ID = 'native-contract-server-modes';

const STAGED_AUTHORITY: Environment = {
  CURRENT_STORE_AUTH_PROJECTION_ID: PROJECTION_ID,
  CURRENT_STORE_DELETED_EMAIL_KEY: 'native-contract-server-modes-deleted-email-key',
  AUTH_CUTOFF_ENFORCEMENT: 'enforce',
};
const SOURCE_BOUND = { AUTH_WATCH_PAIRING_MODE: 'source-bound-staging' };
const STAGED_WRITERS = {
  CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'reserved-staging',
  CURRENT_STORE_NATIVE_OAUTH_MODE: 'reserved-staging',
};
const GENERATION_BLOCKED = 'NATIVE_REVOCATION_ACTIVATION_BLOCKED_GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION';
const WEB_SID_BLOCKED =
  'Web SID denial activation blocked: historical issuer retirement and old no-SID safety proof required';
/** AUTH_LEGACY_BRIDGE_MODE=on refuses to run without the web SID denial writer (auth-protocol). */
const CANONICAL_BRIDGE = {
  AUTH_LEGACY_BRIDGE_MODE: 'on',
  CURRENT_STORE_WEB_SIGNOUT_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_RPC_SECRET: 'native-contract-server-modes-private-rpc-secret',
};
/**
 * The real mirror startup check, run on the cell's selectors and epoch. The cells
 * carry no dedicated credential LOGIN, so it stops there. With one, it would go
 * on to the database checks and then refuse on the code gates
 * (IDENTITY_COPY_CODE_GATES_OPEN, ACTIVATION_CODE_GATES_OPEN); identity-import.proof.ts
 * runs that whole path on a real LOGIN and fence.
 */
const MIRROR_BLOCKED = 'CREDENTIAL_WRITER_UNQUALIFIED';

/**
 * Every selector a native endpoint reads (handlers/native-auth.ts and what it
 * calls), in the order a rollout can turn them on. Prerequisites the code
 * enforces are folded in: an enforced manifest refuses legacy watch codes, so
 * every enforced cell runs source-bound pairing; generation needs source-bound
 * pairing; the canonical bridge needs generation and the web SID denial writer
 * (a web selector the native refresh path depends on); the identity mirror
 * needs both staged native writers and delegated web set-password. Cells run
 * in this order against one database.
 */
export const SERVER_MODES: readonly ServerMode[] = [
  { name: 'legacy', manifest: 'none', selectors: {}, generation: false, startup: 'boots' },
  { name: 'watch source-bound', manifest: 'none', selectors: SOURCE_BOUND, generation: false, startup: 'boots' },
  {
    name: 'enforced current-store manifest',
    manifest: 'current-store',
    selectors: { ...STAGED_AUTHORITY, ...SOURCE_BOUND },
    generation: false,
    startup: 'boots',
  },
  {
    name: 'native registration reserved-staging',
    manifest: 'current-store',
    selectors: {
      ...STAGED_AUTHORITY,
      ...SOURCE_BOUND,
      CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'reserved-staging',
    },
    generation: false,
    startup: 'boots',
  },
  {
    name: 'native OAuth reserved-staging',
    manifest: 'current-store',
    selectors: { ...STAGED_AUTHORITY, ...SOURCE_BOUND, CURRENT_STORE_NATIVE_OAUTH_MODE: 'reserved-staging' },
    generation: false,
    startup: 'boots',
  },
  {
    // Shadow runs every bridge check inside the refresh transaction and writes
    // nothing, so a refused check would surface as a refresh 401.
    name: 'canonical bridge shadow',
    manifest: 'current-store',
    selectors: { ...STAGED_AUTHORITY, ...SOURCE_BOUND, AUTH_LEGACY_BRIDGE_MODE: 'shadow' },
    generation: false,
    startup: 'boots',
  },
  {
    name: 'native revocation generation',
    manifest: 'current-store',
    selectors: { ...STAGED_AUTHORITY, ...SOURCE_BOUND, AUTH_NATIVE_REVOCATION_MODE: 'generation' },
    generation: true,
    startup: [GENERATION_BLOCKED],
  },
  {
    name: 'every native stage on the current-store authority',
    manifest: 'current-store',
    selectors: {
      ...STAGED_AUTHORITY,
      ...SOURCE_BOUND,
      ...STAGED_WRITERS,
      AUTH_NATIVE_REVOCATION_MODE: 'generation',
      ...CANONICAL_BRIDGE,
      AUTH_IDENTITY_MIRROR: 'on',
      // The mirror refuses to run without delegated set-password, which in turn
      // needs required web credential proofs (auth-protocol web-credential-proof.ts).
      CURRENT_STORE_SET_PASSWORD_MODE: 'backend-staging',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
    },
    generation: true,
    startup: [MIRROR_BLOCKED, GENERATION_BLOCKED, WEB_SID_BLOCKED],
  },
  {
    name: 'Better Auth authority, startable today',
    manifest: 'better-auth',
    selectors: { ...STAGED_AUTHORITY, ...SOURCE_BOUND, ...STAGED_WRITERS },
    generation: false,
    startup: 'boots',
  },
  {
    name: 'Better Auth authority, every native stage',
    manifest: 'better-auth',
    selectors: {
      ...STAGED_AUTHORITY,
      ...SOURCE_BOUND,
      ...STAGED_WRITERS,
      AUTH_NATIVE_REVOCATION_MODE: 'generation',
      ...CANONICAL_BRIDGE,
    },
    generation: true,
    startup: [GENERATION_BLOCKED, WEB_SID_BLOCKED],
  },
];

/**
 * What the database and Redis must show after a cell's flows, so a selector
 * that silently fell back to legacy fails the cell instead of passing it.
 */
export interface StageEvidence {
  readonly manifest: ManifestState;
  /** Native registration reserved the new address (only the staged writer reserves). */
  readonly registrationReserved: boolean;
  /** Native OAuth reserved the new account's address. */
  readonly oauthReserved: boolean;
  /** The new password and provider link are in the Better Auth tables. */
  readonly authorityRows: boolean;
  /** A native refresh bound a canonical auth_session row (the bridge). */
  readonly canonicalSession: boolean;
  /** App sign-out wrote a native generation cutoff (null: no cutoff row). */
  readonly nativeGeneration: number | null;
  /** What the phone's pair-code request stored in Redis. */
  readonly pairing: 'uid' | 'v2';
}

export function expectedStageEvidence(mode: ServerMode): StageEvidence {
  const selected = (name: string, value: string) => mode.selectors[name] === value;
  return {
    manifest: mode.manifest,
    registrationReserved: selected('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'reserved-staging'),
    oauthReserved: selected('CURRENT_STORE_NATIVE_OAUTH_MODE', 'reserved-staging'),
    authorityRows: mode.manifest === 'better-auth' || selected('AUTH_IDENTITY_MIRROR', 'on'),
    canonicalSession: selected('AUTH_LEGACY_BRIDGE_MODE', 'on'),
    nativeGeneration: mode.generation ? 1 : null,
    pairing: selected('AUTH_WATCH_PAIRING_MODE', 'source-bound-staging') ? 'v2' : 'uid',
  };
}

/** Every selector the cells set, so each cell starts from legacy/off. */
export const MODE_SELECTORS = [
  ...new Set(SERVER_MODES.flatMap((mode) => Object.keys(mode.selectors))),
  'CURRENT_STORE_AUTH_WRITER_EPOCH',
];

/**
 * Run the four startup guards from index.ts on the cell's selectors and
 * return the messages of those that refuse. Nothing here is weakened: a cell
 * the guards refuse is reported as such and still exercised below them.
 */
export async function startupRefusals(selectors: Environment): Promise<string[]> {
  const environment = {
    NEXTAUTH_SECRET: 'native-contract-only-synthetic-signing-key',
    // The epoch the cell's manifest reached, which the mirror check compares.
    ...(process.env.CURRENT_STORE_AUTH_WRITER_EPOCH
      ? { CURRENT_STORE_AUTH_WRITER_EPOCH: process.env.CURRENT_STORE_AUTH_WRITER_EPOCH }
      : {}),
    ...selectors,
  };
  const [{ assertCutoffEnforcementConfiguration }, mirror, revocation, webSession] = await Promise.all([
    import('../../auth/current-store/authority-configuration'),
    import('../../auth/authority/mirror-activation'),
    import('../../auth/authority/native-revocation-configuration'),
    import('../../auth/current-store/web-session-configuration'),
  ]);
  const refusals: string[] = [];
  // In index.ts order; the mirror's is the one that reads the database, so it is awaited.
  for (const guard of [
    async () => assertCutoffEnforcementConfiguration(environment),
    () => mirror.qualifyIdentityMirrorAtStartup(environment),
    async () => revocation.assertNativeRevocationActivationConfiguration(environment),
    async () => webSession.assertWebSessionWriterActivationConfiguration(environment),
  ]) {
    try {
      await guard();
    } catch (error) {
      refusals.push(error instanceof Error ? error.message : String(error));
    }
  }
  // The startup check clears this process's mirror record. The cell's flows then
  // run writers with the mirror selected and no backend boot (function-level mirror).
  mirror.recordFunctionLevelIdentityMirrorForTests();
  return refusals;
}

/**
 * Move the owned database forward to the cell's manifest, using the routes
 * the authority suites use: prepare the projection under the users table lock
 * and mark it enforced (no production API sets that phase yet), copy every
 * identity into the Better Auth tables with the import primitive, then switch
 * the writer with the real switch core. Returns the manifest's writer epoch.
 */
export async function reachManifest(fixture: Fixture, target: ManifestState): Promise<number | undefined> {
  if (target === 'none') {
    const [manifest] = await fixture.db.select().from(authEmailProjection);
    if (manifest) throw new Error('Server-mode cells only move forward');
    return undefined;
  }
  const { prepareProjectionUnderUsersTableLock } = await import('../../auth/current-store/email-reservations');
  const { switchIdentityAuthority } = await import('../../auth/authority/router');
  const { syncIdentity } = await import('../../auth/authority/sync-identity');
  let [manifest] = await fixture.db.select().from(authEmailProjection);
  if (!manifest) {
    await fixture.db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: PROJECTION_ID });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, PROJECTION_ID));
    });
    [manifest] = await fixture.db.select().from(authEmailProjection);
  }
  if (target === 'better-auth' && manifest.writerAuthority !== 'better-auth') {
    const identities = await fixture.db.select({ id: users.id }).from(users);
    for (const identity of identities) {
      await fixture.db.transaction((transaction) =>
        syncIdentity(transaction, identity.id, 'current-store-to-authority'),
      );
    }
    await fixture.db.transaction((transaction) =>
      switchIdentityAuthority(transaction, {
        projectionId: PROJECTION_ID,
        epoch: manifest.writerEpoch,
        from: 'current-store',
        to: 'better-auth',
      }),
    );
    [manifest] = await fixture.db.select().from(authEmailProjection);
  }
  if (target === 'current-store' && manifest.writerAuthority !== 'current-store')
    throw new Error('Server-mode cells only move forward');
  if (manifest.phase !== 'enforced' || manifest.writerAuthority !== target)
    throw new Error('Owned manifest did not reach the cell state');
  return manifest.writerEpoch;
}
