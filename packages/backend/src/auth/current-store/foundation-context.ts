import type { DbInstance } from '@boardsesh/db/client';
import { executeFirstRow } from '@boardsesh/db/client';
import { authEmailProjection, users } from '@boardsesh/db/schema/auth';
import { eq, sql } from 'drizzle-orm';

export type CurrentStoreTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];
export const CURRENT_EMAIL_NORMALIZER_VERSION = 'js-trim-lower-v1';

export interface ExpectedCurrentStoreAuthority {
  readonly expectedProjectionId: string;
  readonly expectedNormalizerVersion: string;
  readonly expectedWriterEpoch: number;
}

export class CurrentStoreFoundationError extends Error {
  constructor(
    readonly code:
      | 'PROJECTION_EXISTS'
      | 'UNSUPPORTED_ISOLATION'
      | 'AUTHORITY_NOT_ENFORCED'
      | 'STALE_AUTHORITY'
      | 'INVALID_COMMAND'
      | 'EMAIL_RESERVED'
      | 'EMAIL_AMBIGUOUS'
      | 'EMAIL_RETIRED'
      | 'EMAIL_INVALID'
      | 'RESERVATION_INCONSISTENT'
      | 'SUBJECT_DELETED'
      | 'STALE_GENERATION'
      | 'DUPLICATE_OPERATION',
  ) {
    super(`Current-store foundation rejected: ${code}`);
    this.name = 'CurrentStoreFoundationError';
  }
}

/** Copy trusted server context before the first asynchronous boundary. */
export function captureExpectedAuthority(expected: ExpectedCurrentStoreAuthority): ExpectedCurrentStoreAuthority {
  return {
    expectedProjectionId: expected.expectedProjectionId,
    expectedNormalizerVersion: expected.expectedNormalizerVersion,
    expectedWriterEpoch: expected.expectedWriterEpoch,
  };
}

/** Missing rows under an old snapshot can bypass both keys and tombstones. */
export async function requireReadCommitted(transaction: CurrentStoreTransaction): Promise<void> {
  const isolation = await executeFirstRow<{ transaction_isolation: string }>(
    transaction,
    sql`SHOW transaction_isolation`,
  );
  if (isolation?.transaction_isolation !== 'read committed')
    throw new CurrentStoreFoundationError('UNSUPPORTED_ISOLATION');
}

/**
 * The authority gate (epic #6975, BA-04 section 4): one advisory key every staged
 * command takes in shared mode. Shared holders never wait for each other, so two
 * climbers' commands share no lock. Only a writer that changes the manifest takes
 * it exclusively ({@link lockAuthorityGateExclusively}), and every command then
 * waits for that one short transaction. An advisory lock writes no row, so a busy
 * gate leaves no multixact behind on a hot manifest row.
 */
export const AUTHORITY_GATE_NAMESPACE = 6975;
export const AUTHORITY_GATE_KEY = 2;
/** How long an authority switch or activation waits for in-flight commands before giving up. */
export const AUTHORITY_GATE_EXCLUSIVE_LOCK_TIMEOUT = '2000ms';

/**
 * Shared gate, then the manifest in a statement of its own. A READ COMMITTED
 * statement takes its snapshot before any lock it waits for, so the read must
 * start after the gate is held to see a switch that committed during the wait.
 * Re-entrant: a second call in the same transaction never waits.
 *
 * This marker is a fail-closed software prerequisite, never proof of a role
 * fence. No production API in this slice can set the enforced phase.
 */
export async function lockEnforcedProjection(
  transaction: CurrentStoreTransaction,
  expected: ExpectedCurrentStoreAuthority,
) {
  await requireReadCommitted(transaction);
  await transaction.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(${AUTHORITY_GATE_NAMESPACE}, ${AUTHORITY_GATE_KEY})`,
  );
  // No row lock: only the gate keeps this row still until commit. So every
  // writer of the manifest (PR 5's activate, PR 11's switch) must hold
  // lockAuthorityGateExclusively; one that skips it is caught only by a later
  // re-validation in the same command, if there is one.
  const [manifest] = await transaction
    .select()
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true));
  if (!manifest || manifest.phase !== 'enforced') throw new CurrentStoreFoundationError('AUTHORITY_NOT_ENFORCED');
  if (
    manifest.projectionId !== expected.expectedProjectionId ||
    manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
    expected.expectedNormalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
    manifest.writerEpoch !== expected.expectedWriterEpoch ||
    !Number.isSafeInteger(expected.expectedWriterEpoch) ||
    expected.expectedWriterEpoch <= 0
  ) {
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  }
  return manifest;
}

/**
 * Only for a writer that changes the manifest: an authority activation or switch.
 * It waits for every command in flight and holds every new one back until it
 * commits, so it must stay one short transaction. A command still running after
 * the limit fails the switch with 55P03, never the command. Take it first, before
 * any row lock: a command holding the gate never waits on the switch's rows.
 *
 * For PR 5 and PR 11: an account deletion holds the shared gate through its
 * whole content and cascade. A switch started during one queues for its 2 s, and
 * every staged command arriving meanwhile queues behind the switch, so staged
 * auth stalls for about 2 s and the switch then fails. Retry it; do not raise
 * the limit.
 */
export async function lockAuthorityGateExclusively(transaction: CurrentStoreTransaction): Promise<void> {
  await requireReadCommitted(transaction);
  await transaction.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${AUTHORITY_GATE_EXCLUSIVE_LOCK_TIMEOUT}'`)}`);
  await transaction.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock(${AUTHORITY_GATE_NAMESPACE}, ${AUTHORITY_GATE_KEY})`,
  );
}

/** Keys for the two creation locks below; distinct from every other advisory namespace in the repo. */
const EMAIL_KEY_LOCK_NAMESPACE = 0x454d4b59; // 'EMKY'
const PROVIDER_SUBJECT_LOCK_NAMESPACE = 0x50535542; // 'PSUB'

/**
 * Creation's place in section 4's lock order ("email reservation, creation
 * only"): taken after the gate and before the reservation row is read. A key
 * with no reservation row yet has no row to lock, and the gate no longer
 * serializes commands, so two registrations, provider sign-ins or system
 * identities for one address would otherwise both find it free. Different
 * addresses share nothing but, rarely, a 32-bit hash bucket, and each command
 * takes at most one such key, so that only queues them. A command that already
 * owns an account locks its users row instead and never takes this.
 */
export async function lockEmailKeyForCreation(
  transaction: CurrentStoreTransaction,
  normalizedEmail: string,
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock(${EMAIL_KEY_LOCK_NAMESPACE}, pg_catalog.hashtext(${normalizedEmail}))`,
  );
}

/**
 * One provider subject at a time, taken after the gate and before its link is
 * read, so two sign-ins with the same subject but different email claims
 * cannot both find no link and create two accounts. Before the email key and
 * before any users row: the same subject resolves to one account.
 */
export async function lockProviderSubject(
  transaction: CurrentStoreTransaction,
  provider: string,
  subject: string,
): Promise<void> {
  await transaction.execute(
    // The provider is a fixed name with no colon, so the joined text is unambiguous.
    sql`SELECT pg_catalog.pg_advisory_xact_lock(${PROVIDER_SUBJECT_LOCK_NAMESPACE}, pg_catalog.hashtext(${`${provider}:${subject}`}))`,
  );
}

/**
 * The per-climber lock every staged mutation takes before any other row of that
 * climber, the reservation of their email included (section 4's lock order:
 * gate, reservation for creation only, users, cutoffs, credentials, refresh rows).
 * Account deletion takes the same row after its walls and holds it through the
 * cascade, so a command naming that account waits for it, up to the command's own
 * lock limit; no other climber's command shares this lock. FOR UPDATE, not a
 * weaker mode: it must wait out an uncommitted foreign-key insert for this UID.
 */
export async function lockSubjectRow(transaction: CurrentStoreTransaction, userId: string) {
  const [user] = await transaction.select().from(users).where(eq(users.id, userId)).for('update');
  return user;
}
