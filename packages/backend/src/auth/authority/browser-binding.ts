import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import {
  authBrowserBindings,
  authBrowserIntents,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  users,
} from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityQualification,
  type IdentityAuthorityReceipt,
} from './router';
import {
  readFirstPartySession,
  type FirstPartyCredential,
  type FirstPartySession,
  type FirstPartySessionResult,
} from './session-reader';
import { readLockedWebSubjectState } from '../current-store/web-credential-state';
import { denyFirstPartySessionInTransaction } from './lineage';
import { transactionSettings } from '../current-store/command-context';
import {
  requireFirstPartyContinuationMutationReceipt,
  type IdentityGenerationMutationReceipt,
  type FirstPartyContinuationMutationKind,
} from '../current-store/security-mutation-core';

/** No public bootstrap or session route is mounted. An origin-local fallback
 * cannot establish the shared www/app coordinator required for activation. */
export const BROWSER_BINDING_PUBLIC_BOOTSTRAP_READY = false;
export function assertBrowserBindingPublicBootstrap(): never {
  throw new Error('BROWSER_BINDING_COORDINATOR_UNQUALIFIED');
}

const MAX_VERSION = 2_147_483_647;
const INTENT_LIFETIME_MS = 15 * 60 * 1000;
const MAX_BINDING_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
function copyPossession(presented: BrowserSelectionCredential | undefined): BrowserSelectionCredential | undefined {
  return presented
    ? Object.freeze({ version: presented.version, credential: Object.freeze({ ...presented.credential }) })
    : undefined;
}
function credentialHash(credential: FirstPartyCredential): string {
  return digest(
    JSON.stringify([
      'browser-selection-credential-v2',
      credential.kind,
      credential.kind === 'canonical-token' ? credential.token : credential.credential,
    ]),
  );
}
function actorHash(presented: BrowserSelectionCredential | undefined): string | null {
  return presented
    ? digest(
        JSON.stringify([
          'browser-intent-actor-v2',
          presented.version,
          credentialHash(presented.credential),
          presented.credential.kind === 'legacy-jwe' ? digest(presented.credential.secret) : null,
        ]),
      )
    : null;
}
type BindingRow = typeof authBrowserBindings.$inferSelect;
type IntentRow = typeof authBrowserIntents.$inferSelect;
export type BrowserIntentOperation = 'login' | 'replacement' | 'logout';
export interface BrowserBindingCursor {
  readonly bindingId: string;
  readonly version: number;
  /** Fixed at initialization: delayed replies cannot shorten a later login's cookie. */
  readonly bindingExpiresAt: Date;
}
/** The stable binding is correlation only. Possession belongs to the exact
 * version-named source credential cookie, never to the stored SID. */
export interface BrowserSelectionCredential {
  readonly version: number;
  readonly credential: FirstPartyCredential;
}
type Refusal = { readonly status: 'denied' | 'conflict' | 'unavailable' };
export type BrowserBindingReadResult =
  | { readonly status: 'admitted'; readonly cursor: BrowserBindingCursor; readonly session: FirstPartySession }
  | { readonly status: 'anonymous'; readonly cursor: BrowserBindingCursor }
  | Refusal;
export type BrowserBindingCommitResult =
  | {
      readonly status: 'committed' | 'already-committed';
      readonly cursor: BrowserBindingCursor;
      readonly session: FirstPartySession | null;
    }
  | Refusal;

function cursor(binding: BindingRow): BrowserBindingCursor {
  return Object.freeze({
    bindingId: binding.id,
    version: binding.version,
    bindingExpiresAt: new Date(binding.expiresAt),
  });
}
function nextVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0 || version >= MAX_VERSION)
    throw new Error('BROWSER_BINDING_VERSION_EXHAUSTED');
  return version + 1;
}
async function databaseNow(transaction: AuthorityTransaction): Promise<Date> {
  const clock = await executeFirstRow<{ now: Date | string }>(transaction, sql`SELECT clock_timestamp() AS now`);
  if (!clock) throw new Error('BROWSER_BINDING_CLOCK_UNAVAILABLE');
  const now = new Date(clock.now);
  if (!Number.isFinite(now.getTime())) throw new Error('BROWSER_BINDING_CLOCK_UNAVAILABLE');
  return now;
}
async function withAuthority<T>(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  operation: (transaction: AuthorityTransaction, receipt: IdentityAuthorityReceipt) => Promise<T>,
): Promise<T | { readonly status: 'unavailable' }> {
  const requested = { ...qualification };
  try {
    return await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const receipt = await captureIdentityAuthority(transaction, requested);
      const result = await operation(transaction, receipt);
      await revalidateIdentityAuthority(transaction, receipt);
      return result;
    });
  } catch {
    // Neither a failed transaction nor uncertain COMMIT may report publication.
    return { status: 'unavailable' };
  }
}
function selectedSession(binding: BindingRow): FirstPartySession | null {
  if (binding.userId === null) {
    if (
      binding.credentialKind !== null ||
      binding.authSessionId !== null ||
      binding.generation !== null ||
      binding.authenticatedAt !== null ||
      binding.credentialExpiresAt !== null ||
      binding.requiresAccountCutoff ||
      binding.linkGuarded
    )
      throw new Error('BROWSER_BINDING_SELECTION_MALFORMED');
    return null;
  }
  if (
    !binding.userId ||
    !['legacy-jwe', 'canonical-token'].includes(binding.credentialKind ?? '') ||
    !binding.authSessionId ||
    binding.generation === null ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 0 ||
    !binding.credentialExpiresAt ||
    (binding.linkGuarded && !binding.authenticatedAt)
  )
    throw new Error('BROWSER_BINDING_SELECTION_MALFORMED');
  return Object.freeze({
    userId: binding.userId,
    authSessionId: binding.authSessionId,
    generation: binding.generation,
    authenticatedAt: binding.authenticatedAt ? new Date(binding.authenticatedAt) : null,
    expiresAt: new Date(binding.credentialExpiresAt),
    requiresAccountCutoff: binding.requiresAccountCutoff,
    linkGuarded: binding.linkGuarded,
  });
}
async function lockUser(transaction: AuthorityTransaction, userId: string) {
  await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}
function sameSessionEvidence(left: FirstPartySession, right: FirstPartySession): boolean {
  return (
    left.userId === right.userId &&
    left.authSessionId === right.authSessionId &&
    left.generation === right.generation &&
    left.authenticatedAt?.getTime() === right.authenticatedAt?.getTime() &&
    left.linkGuarded === right.linkGuarded &&
    left.requiresAccountCutoff === right.requiresAccountCutoff
  );
}
function boundedSession(original: FirstPartySession, current: FirstPartySession): FirstPartySession {
  return Object.freeze({
    ...original,
    expiresAt: new Date(Math.min(original.expiresAt.getTime(), current.expiresAt.getTime())),
  });
}
async function admitSelection(
  transaction: AuthorityTransaction,
  binding: BindingRow,
  session: FirstPartySession,
  presented: BrowserSelectionCredential | undefined,
  now: Date,
): Promise<FirstPartySessionResult> {
  if (!presented || presented.version !== binding.version || presented.credential.kind !== binding.credentialKind)
    return { status: 'denied' };
  if (session.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
  const admitted = await readFirstPartySession(transaction, presented.credential, now, (userId) =>
    readLockedWebSubjectState(transaction, userId),
  );
  if (admitted.status !== 'admitted') return admitted;
  if (!sameSessionEvidence(session, admitted.session)) return { status: 'denied' };
  return { status: 'admitted', session: boundedSession(session, admitted.session) };
}
async function findBinding(transaction: AuthorityTransaction, token: string, lock = false) {
  const query = transaction
    .select()
    .from(authBrowserBindings)
    .where(eq(authBrowserBindings.id, digest(token)));
  const [binding] = await (lock ? query.for('update') : query);
  return binding;
}
function intentMatches(intent: IntentRow, binding: BindingRow, receipt: IdentityAuthorityReceipt, now: Date) {
  return (
    intent.formatVersion === 2 &&
    intent.bindingId === binding.id &&
    intent.revision === binding.intentRevision &&
    intent.projectionId === receipt.projectionId &&
    intent.authority === receipt.authority &&
    intent.epoch === receipt.epoch &&
    intent.expiresAt.getTime() > now.getTime() &&
    binding.expiresAt.getTime() > now.getTime()
  );
}
async function findIntent(transaction: AuthorityTransaction, token: string) {
  const [intent] = await transaction
    .select()
    .from(authBrowserIntents)
    .where(eq(authBrowserIntents.id, digest(token)))
    .for('update');
  return intent;
}
async function applySelection(
  transaction: AuthorityTransaction,
  binding: BindingRow,
  intent: IntentRow,
  session: FirstPartySession | null,
  now: Date,
  credentialKind: FirstPartyCredential['kind'] | null,
  resultCredentialHash: string | null,
) {
  const version = nextVersion(binding.version);
  const [updated] = await transaction
    .update(authBrowserBindings)
    .set({
      version,
      userId: session?.userId ?? null,
      credentialKind,
      authSessionId: session?.authSessionId ?? null,
      generation: session?.generation ?? null,
      authenticatedAt: session?.authenticatedAt ?? null,
      credentialExpiresAt: session?.expiresAt ?? null,
      requiresAccountCutoff: session?.requiresAccountCutoff ?? false,
      linkGuarded: session?.linkGuarded ?? false,
    })
    .where(
      and(
        eq(authBrowserBindings.id, binding.id),
        eq(authBrowserBindings.version, intent.expectedVersion),
        eq(authBrowserBindings.intentRevision, intent.revision),
      ),
    )
    .returning();
  if (!updated) throw new Error('BROWSER_BINDING_CAS_LOST');
  await transaction
    .update(authBrowserIntents)
    .set({ consumedAt: now, resultVersion: version, resultCredentialHash })
    .where(eq(authBrowserIntents.id, intent.id));
  const finished = await databaseNow(transaction);
  if (
    binding.expiresAt.getTime() <= finished.getTime() ||
    intent.expiresAt.getTime() <= finished.getTime() ||
    (session && session.expiresAt.getTime() <= finished.getTime())
  )
    throw new Error('BROWSER_SELECTION_DEADLINE_PASSED');
  return { status: 'committed' as const, cursor: cursor(updated), session };
}
function replay(intent: IntentRow, binding: BindingRow): BrowserBindingCommitResult | undefined {
  if (intent.consumedAt === null) return undefined;
  if (intent.resultVersion !== binding.version) return { status: 'conflict' };
  return { status: 'already-committed', cursor: cursor(binding), session: selectedSession(binding) };
}

function sameSelection(left: FirstPartySession, right: FirstPartySession): boolean {
  return (
    left.userId === right.userId &&
    left.authSessionId === right.authSessionId &&
    left.generation === right.generation &&
    left.authenticatedAt?.getTime() === right.authenticatedAt?.getTime() &&
    left.expiresAt.getTime() === right.expiresAt.getTime() &&
    left.linkGuarded === right.linkGuarded &&
    left.requiresAccountCutoff === right.requiresAccountCutoff
  );
}

/** Private core only. The caller must establish one canonical-origin bootstrap
 * before issuing intents. This does not qualify that missing browser coordinator. */
export async function createUnpublishedBrowserBinding(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  requestedExpiry?: Date,
): Promise<{ readonly status: 'created'; readonly token: string; readonly cursor: BrowserBindingCursor } | Refusal> {
  const suppliedExpiry = requestedExpiry ? new Date(requestedExpiry) : undefined;
  const token = randomBytes(32).toString('base64url');
  return withAuthority(database, qualification, async (transaction) => {
    const now = await databaseNow(transaction);
    const expiresAt = suppliedExpiry ?? new Date(now.getTime() + MAX_BINDING_LIFETIME_MS);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() - now.getTime() > MAX_BINDING_LIFETIME_MS
    )
      return { status: 'denied' as const };
    const [binding] = await transaction
      .insert(authBrowserBindings)
      .values({ id: digest(token), createdAt: now, expiresAt })
      .returning();
    return { status: 'created' as const, token, cursor: cursor(binding) };
  });
}

export type BrowserBindingDescriptorResult =
  | {
      readonly status: 'known';
      readonly state: 'anonymous' | 'selected';
      readonly cursor: BrowserBindingCursor;
      readonly credentialKind: FirstPartyCredential['kind'] | null;
    }
  | Refusal;

/** Correlation metadata is not authenticated identity. It only lets the thin
 * server adapter choose the exact version-named cookie for actual admission. */
export async function describeBrowserBinding(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  token: string,
): Promise<BrowserBindingDescriptorResult> {
  if (!tokenPattern.test(token)) return { status: 'denied' };
  return withAuthority(database, qualification, async (transaction) => {
    const binding = await findBinding(transaction, token);
    const now = await databaseNow(transaction);
    if (!binding || binding.expiresAt.getTime() <= now.getTime()) return { status: 'denied' as const };
    const selected = selectedSession(binding);
    return {
      status: 'known' as const,
      state: selected ? ('selected' as const) : ('anonymous' as const),
      cursor: cursor(binding),
      credentialKind: selected ? (binding.credentialKind as FirstPartyCredential['kind']) : null,
    };
  });
}

/** Primary admission is repeated on every read. Presence of a refused binding
 * must never cause a reader to fall through to an older legacy cookie. */
export async function readBrowserBinding(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  token: string,
  presented?: BrowserSelectionCredential,
): Promise<BrowserBindingReadResult> {
  const possession = copyPossession(presented);
  if (!tokenPattern.test(token)) return { status: 'denied' };
  return withAuthority(database, qualification, (transaction) =>
    readLockedBrowserBinding(transaction, token, possession),
  );
}

async function readLockedBrowserBinding(
  transaction: AuthorityTransaction,
  token: string,
  possession: BrowserSelectionCredential | undefined,
): Promise<BrowserBindingReadResult> {
  const observed = await findBinding(transaction, token);
  if (!observed) return { status: 'denied' };
  if (observed.userId) await lockUser(transaction, observed.userId);
  const binding = await findBinding(transaction, token, true);
  if (!binding || binding.version !== observed.version) return { status: 'conflict' };
  const now = await databaseNow(transaction);
  if (binding.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
  const session = selectedSession(binding);
  if (!session) return { status: 'anonymous', cursor: cursor(binding) };
  const admitted = await admitSelection(transaction, binding, session, possession, now);
  return admitted.status === 'admitted'
    ? { status: 'admitted', cursor: cursor(binding), session: admitted.session }
    : { status: admitted.status };
}

/** Compose an authenticated command in the caller's already-owned transaction;
 * it cannot obtain a fresh credential from correlation metadata. */
export async function readBrowserBindingInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  requested: { readonly bindingToken: string; readonly actor?: BrowserSelectionCredential },
): Promise<BrowserBindingReadResult> {
  const { bindingToken } = requested;
  const actor = copyPossession(requested.actor);
  if (!tokenPattern.test(bindingToken)) return { status: 'denied' };
  await revalidateIdentityAuthority(transaction, authority);
  const result = await readLockedBrowserBinding(transaction, bindingToken, actor);
  await revalidateIdentityAuthority(transaction, authority);
  return result;
}

/** Strict anonymous preparation only. A caller may already own a target user's
 * lock. Never discover and lock a different selected user after that target;
 * selected, malformed and changed bindings refuse without account admission. */
export async function readAnonymousBrowserBindingInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  requested: { readonly bindingToken: string; readonly expectedVersion: number },
): Promise<{ readonly status: 'anonymous'; readonly cursor: BrowserBindingCursor } | Refusal> {
  const { bindingToken, expectedVersion } = requested;
  if (
    !tokenPattern.test(bindingToken) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion >= MAX_VERSION
  )
    return { status: 'denied' };
  await revalidateIdentityAuthority(transaction, authority);
  const binding = await findBinding(transaction, bindingToken, true);
  const now = await databaseNow(transaction);
  if (!binding || binding.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
  if (binding.version !== expectedVersion || selectedSession(binding) !== null) return { status: 'conflict' };
  await revalidateIdentityAuthority(transaction, authority);
  return { status: 'anonymous', cursor: cursor(binding) };
}

/** Read-only exact anonymous-login ACK. The caller holds the actual candidate;
 * a different selected owner is refused before any unexpected user-row lock.
 * This never applies a selection or retrieves a stored credential. */
export async function acknowledgeAnonymousBrowserLoginInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  requested: {
    readonly bindingToken: string;
    readonly intentToken: string;
    readonly expectedVersion: number;
    readonly expectedUserId: string;
    readonly expectedAuthSessionId: string;
    readonly credential: FirstPartyCredential;
  },
): Promise<BrowserBindingCommitResult> {
  const { bindingToken, intentToken, expectedVersion, expectedUserId, expectedAuthSessionId } = requested;
  const credential = Object.freeze({ ...requested.credential });
  if (
    !tokenPattern.test(bindingToken) ||
    !tokenPattern.test(intentToken) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion >= MAX_VERSION ||
    !expectedUserId ||
    !expectedAuthSessionId
  )
    return { status: 'denied' };
  await revalidateIdentityAuthority(transaction, authority);
  await lockUser(transaction, expectedUserId);
  const binding = await findBinding(transaction, bindingToken, true);
  const now = await databaseNow(transaction);
  if (!binding || binding.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
  const session = selectedSession(binding);
  if (
    !session ||
    binding.version !== expectedVersion + 1 ||
    session.userId !== expectedUserId ||
    session.authSessionId !== expectedAuthSessionId ||
    binding.credentialKind !== credential.kind
  )
    return { status: 'conflict' };
  const intent = await findIntent(transaction, intentToken);
  if (
    !intent ||
    !intentMatches(intent, binding, authority, now) ||
    intent.operation !== 'login' ||
    intent.actorCredentialHash !== null ||
    intent.expectedVersion !== expectedVersion ||
    intent.consumedAt === null ||
    intent.resultVersion !== binding.version ||
    intent.resultCredentialHash !== credentialHash(credential)
  )
    return { status: 'conflict' };
  const admitted = await readFirstPartySession(transaction, credential, now, async (userId) =>
    userId === expectedUserId ? await readLockedWebSubjectState(transaction, userId) : undefined,
  );
  if (admitted.status !== 'admitted') return { status: admitted.status };
  if (!sameSessionEvidence(session, admitted.session)) return { status: 'denied' };
  if (
    (await databaseNow(transaction)).getTime() >=
    Math.min(binding.expiresAt.getTime(), intent.expiresAt.getTime(), admitted.session.expiresAt.getTime())
  )
    return { status: 'denied' };
  await revalidateIdentityAuthority(transaction, authority);
  return { status: 'already-committed', cursor: cursor(binding), session: admitted.session };
}

/** Anonymous login only. Do not look up or lock a selected owner merely to
 * discover that this source-free operation has no permission to act for them. */
export async function beginAnonymousBrowserIntent(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  requested: { readonly bindingToken: string; readonly expectedVersion: number },
): Promise<
  | {
      readonly status: 'prepared';
      readonly intentToken: string;
      readonly cursor: BrowserBindingCursor;
      readonly expiresAt: Date;
    }
  | Refusal
> {
  const input = Object.freeze({ ...requested });
  const intentToken = randomBytes(32).toString('base64url');
  return withAuthority(database, qualification, async (transaction, authority) => {
    const admitted = await readAnonymousBrowserBindingInTransaction(transaction, authority, input);
    if (admitted.status !== 'anonymous') return admitted;
    // The strict reader holds this exact anonymous row through commit.
    const binding = await findBinding(transaction, input.bindingToken);
    if (!binding) return { status: 'denied' as const };
    const now = await databaseNow(transaction);
    const expiresAt = new Date(Math.min(now.getTime() + INTENT_LIFETIME_MS, binding.expiresAt.getTime()));
    if (expiresAt.getTime() <= now.getTime()) return { status: 'denied' as const };
    const revision = nextVersion(binding.intentRevision);
    await transaction
      .update(authBrowserBindings)
      .set({ intentRevision: revision })
      .where(eq(authBrowserBindings.id, binding.id));
    await transaction.insert(authBrowserIntents).values({
      id: digest(intentToken),
      bindingId: binding.id,
      revision,
      expectedVersion: binding.version,
      operation: 'login',
      formatVersion: 2,
      actorCredentialHash: null,
      projectionId: authority.projectionId,
      authority: authority.authority,
      epoch: authority.epoch,
      createdAt: now,
      expiresAt,
    });
    if ((await databaseNow(transaction)).getTime() >= expiresAt.getTime())
      throw new Error('BROWSER_SELECTION_DEADLINE_PASSED');
    return { status: 'prepared' as const, intentToken, cursor: cursor(binding), expiresAt };
  });
}

export async function beginBrowserIntent(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  bindingToken: string,
  requested: {
    readonly operation: BrowserIntentOperation;
    readonly expectedVersion: number;
    readonly expectedIdentity?: { readonly userId: string; readonly authSessionId: string };
    readonly presented?: BrowserSelectionCredential;
  },
): Promise<
  | {
      readonly status: 'prepared';
      readonly intentToken: string;
      readonly cursor: BrowserBindingCursor;
      readonly expiresAt: Date;
    }
  | Refusal
> {
  const input = {
    ...requested,
    expectedIdentity: requested.expectedIdentity ? { ...requested.expectedIdentity } : undefined,
    presented: copyPossession(requested.presented),
  };
  if (
    !tokenPattern.test(bindingToken) ||
    !['login', 'replacement', 'logout'].includes(input.operation) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    return { status: 'denied' };
  const intentToken = randomBytes(32).toString('base64url');
  return withAuthority(database, qualification, async (transaction, receipt) => {
    const observed = await findBinding(transaction, bindingToken);
    if (observed?.userId) await lockUser(transaction, observed.userId);
    const binding = await findBinding(transaction, bindingToken, true);
    const now = await databaseNow(transaction);
    if (!binding || binding.expiresAt.getTime() <= now.getTime()) return { status: 'denied' as const };
    if (binding.version !== input.expectedVersion || binding.version !== observed?.version)
      return { status: 'conflict' as const };
    const selection = selectedSession(binding);
    let actorDeadline = binding.expiresAt.getTime();
    if (selection) {
      const admitted = await admitSelection(transaction, binding, selection, input.presented, now);
      if (admitted.status !== 'admitted') return { status: admitted.status };
      actorDeadline = admitted.session.expiresAt.getTime();
    } else if (input.presented) return { status: 'denied' as const };
    if (
      (input.operation !== 'login' || input.expectedIdentity !== undefined) &&
      (!input.expectedIdentity ||
        input.expectedIdentity.userId !== binding.userId ||
        input.expectedIdentity.authSessionId !== binding.authSessionId)
    )
      return { status: 'conflict' as const };
    const revision = nextVersion(binding.intentRevision);
    const expiresAt = new Date(
      Math.min(now.getTime() + INTENT_LIFETIME_MS, binding.expiresAt.getTime(), actorDeadline),
    );
    await transaction
      .update(authBrowserBindings)
      .set({ intentRevision: revision })
      .where(eq(authBrowserBindings.id, binding.id));
    await transaction.insert(authBrowserIntents).values({
      id: digest(intentToken),
      bindingId: binding.id,
      revision,
      expectedVersion: binding.version,
      operation: input.operation,
      formatVersion: 2,
      actorCredentialHash: actorHash(input.presented),
      projectionId: receipt.projectionId,
      authority: receipt.authority,
      epoch: receipt.epoch,
      createdAt: now,
      expiresAt,
    });
    return { status: 'prepared' as const, intentToken, cursor: cursor(binding), expiresAt };
  });
}

export async function commitBrowserLogin(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  bindingToken: string,
  intentToken: string,
  presented: FirstPartyCredential,
  presentedActor?: BrowserSelectionCredential,
): Promise<BrowserBindingCommitResult> {
  const credential = { ...presented };
  const actor = copyPossession(presentedActor);
  if (!tokenPattern.test(bindingToken) || !tokenPattern.test(intentToken)) return { status: 'denied' };
  return withAuthority(database, qualification, (transaction, receipt) =>
    commitBrowserLoginInTransaction(transaction, receipt, bindingToken, intentToken, credential, actor),
  );
}

/** The credential issuer owns the transaction: source admission, its durable
 * flow and this login CAS commit together, after final response buffering. */
export async function commitBrowserLoginInTransaction(
  transaction: AuthorityTransaction,
  receipt: IdentityAuthorityReceipt,
  bindingToken: string,
  intentToken: string,
  presented: FirstPartyCredential,
  presentedActor?: BrowserSelectionCredential,
): Promise<BrowserBindingCommitResult> {
  const credential = { ...presented };
  const actor = copyPossession(presentedActor);
  if (!tokenPattern.test(bindingToken) || !tokenPattern.test(intentToken)) return { status: 'denied' };
  await revalidateIdentityAuthority(transaction, receipt);
  const commit = async (): Promise<BrowserBindingCommitResult> => {
    const observed = await findBinding(transaction, bindingToken);
    const admitted = await readFirstPartySession(transaction, credential, await databaseNow(transaction), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    );
    if (admitted.status !== 'admitted') return { status: admitted.status };
    const userIds = new Set([admitted.session.userId, ...(observed?.userId ? [observed.userId] : [])]);
    for (const userId of [...userIds].sort()) await lockUser(transaction, userId);
    const binding = await findBinding(transaction, bindingToken, true);
    const intent = await findIntent(transaction, intentToken);
    const now = await databaseNow(transaction);
    if (
      !binding ||
      !intent ||
      !intentMatches(intent, binding, receipt, now) ||
      intent.operation === 'logout' ||
      intent.actorCredentialHash !== actorHash(actor)
    )
      return { status: 'conflict' as const };
    if (admitted.session.expiresAt.getTime() <= now.getTime()) return { status: 'conflict' as const };
    let selected = admitted.session;
    {
      // Both user locks precede the binding lock; re-admit the actual presented
      // source after all waits, without extending the initially observed proof.
      const current = await readFirstPartySession(transaction, credential, now, (userId) =>
        readLockedWebSubjectState(transaction, userId),
      );
      if (current.status !== 'admitted') return { status: current.status };
      if (!sameSessionEvidence(admitted.session, current.session)) return { status: 'denied' as const };
      selected = boundedSession(admitted.session, current.session);
    }
    const already = replay(intent, binding);
    if (already) {
      // A different valid credential must never acknowledge a stored selection
      // whose owner/SID or primary revocation state was not checked above.
      if (already.status !== 'already-committed') return already;
      if (
        !already.session ||
        binding.credentialKind !== credential.kind ||
        intent.resultCredentialHash !== credentialHash(credential) ||
        !(credential.kind === 'canonical-token'
          ? sameSessionEvidence(already.session, selected)
          : sameSelection(already.session, selected))
      )
        return { status: 'conflict' as const };
      const current = await admitSelection(
        transaction,
        binding,
        already.session,
        { version: binding.version, credential },
        now,
      );
      return current.status === 'admitted' ? { ...already, session: current.session } : { status: current.status };
    }
    if (binding.version !== intent.expectedVersion || binding.version !== observed?.version)
      return { status: 'conflict' as const };
    // Preservation is allowed only by the same-transaction preparation/mutation
    // seam below. A generation increment alone cannot authorize replacement.
    if (intent.operation === 'replacement') return { status: 'denied' as const };
    const previous = selectedSession(binding);
    if (previous) {
      const current = await admitSelection(transaction, binding, previous, actor, now);
      if (current.status !== 'admitted') return { status: current.status };
    } else if (actor) return { status: 'denied' as const };
    return applySelection(transaction, binding, intent, selected, now, credential.kind, credentialHash(credential));
  };
  const result = await commit();
  await revalidateIdentityAuthority(transaction, receipt);
  return result;
}

/** Exact displayed owner/SID is bound when the intent is prepared. A delayed
 * logout cannot move or revoke a newer binding selection, including same UID. */
export async function commitBrowserLogout(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  bindingToken: string,
  intentToken: string,
  presentedActor?: BrowserSelectionCredential,
): Promise<BrowserBindingCommitResult> {
  const actor = copyPossession(presentedActor);
  if (!tokenPattern.test(bindingToken) || !tokenPattern.test(intentToken)) return { status: 'denied' };
  return withAuthority(database, qualification, async (transaction, receipt) => {
    const observed = await findBinding(transaction, bindingToken);
    if (!observed) return { status: 'denied' as const };
    if (observed.userId) await lockUser(transaction, observed.userId);
    const binding = await findBinding(transaction, bindingToken, true);
    const intent = await findIntent(transaction, intentToken);
    const now = await databaseNow(transaction);
    if (
      !binding ||
      !intent ||
      !intentMatches(intent, binding, receipt, now) ||
      intent.operation !== 'logout' ||
      !actor ||
      intent.actorCredentialHash !== actorHash(actor)
    )
      return { status: 'conflict' as const };
    const already = replay(intent, binding);
    if (already) return already;
    if (binding.version !== observed.version || binding.version !== intent.expectedVersion)
      return { status: 'conflict' as const };
    const session = selectedSession(binding);
    if (!session) return { status: 'conflict' as const };
    const current = await admitSelection(transaction, binding, session, actor, now);
    if (current.status === 'unavailable') return { status: 'unavailable' as const };
    // A refused old selection may clear only this binding. It cannot revoke a
    // later login that still belongs to the same account generation.
    if (current.status === 'admitted')
      await denyFirstPartySessionInTransaction(transaction, current.session, now, {
        expectedProjectionId: receipt.projectionId,
        expectedNormalizerVersion: receipt.normalizerVersion,
        expectedWriterEpoch: receipt.epoch,
      });
    return applySelection(transaction, binding, intent, null, now, null, null);
  });
}

declare const browserReplacementPreparationBrand: unique symbol;
export interface BrowserReplacementPreparation {
  readonly [browserReplacementPreparationBrand]: true;
}
interface PreparedReplacement {
  readonly transaction: AuthorityTransaction;
  readonly authority: IdentityAuthorityReceipt;
  readonly bindingId: string;
  readonly intentId: string;
  readonly source: FirstPartySession;
  readonly actorCredentialHash: string;
  readonly candidate: FirstPartyCredential;
  readonly candidateHash: string;
  readonly operationId: string;
  readonly kind: FirstPartyContinuationMutationKind;
  readonly expectedVersion: number;
  readonly revision: number;
  readonly deadline: Date;
}
const preparedReplacements = new WeakMap<BrowserReplacementPreparation, PreparedReplacement>();

/** Call before the real security mutation, in its physical outer transaction.
 * This proves source possession while its old generation is still current. */
export async function prepareBrowserReplacementInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  requested: {
    readonly bindingToken: string;
    readonly intentToken: string;
    readonly actor: BrowserSelectionCredential;
    readonly candidate: FirstPartyCredential;
    readonly operationId: string;
    readonly kind: FirstPartyContinuationMutationKind;
  },
): Promise<BrowserReplacementPreparation> {
  const { bindingToken, intentToken, operationId, kind } = requested;
  const actor = copyPossession(requested.actor);
  const candidate = Object.freeze({ ...requested.candidate });
  if (
    !actor ||
    !tokenPattern.test(bindingToken) ||
    !tokenPattern.test(intentToken) ||
    !operationId ||
    operationId !== operationId.trim() ||
    !['password-set', 'password-change', 'provider-link', 'provider-unlink'].includes(kind)
  )
    throw new Error('BROWSER_REPLACEMENT_PREPARATION_REFUSED');
  await revalidateIdentityAuthority(transaction, authority);
  const observed = await findBinding(transaction, bindingToken);
  if (!observed?.userId) throw new Error('BROWSER_REPLACEMENT_PREPARATION_REFUSED');
  await lockUser(transaction, observed.userId);
  const binding = await findBinding(transaction, bindingToken, true);
  const intent = await findIntent(transaction, intentToken);
  const now = await databaseNow(transaction);
  if (
    !binding ||
    !intent ||
    !intentMatches(intent, binding, authority, now) ||
    intent.operation !== 'replacement' ||
    intent.consumedAt ||
    binding.version !== observed.version ||
    binding.version !== intent.expectedVersion ||
    intent.actorCredentialHash !== actorHash(actor) ||
    binding.credentialKind !== candidate.kind
  )
    throw new Error('BROWSER_REPLACEMENT_PREPARATION_REFUSED');
  const source = selectedSession(binding);
  if (!source) throw new Error('BROWSER_REPLACEMENT_PREPARATION_REFUSED');
  const admitted = await admitSelection(transaction, binding, source, actor, now);
  if (admitted.status !== 'admitted') throw new Error('BROWSER_REPLACEMENT_PREPARATION_REFUSED');
  const preparation = Object.freeze({}) as BrowserReplacementPreparation;
  preparedReplacements.set(
    preparation,
    Object.freeze({
      transaction,
      authority,
      bindingId: binding.id,
      intentId: intent.id,
      source: admitted.session,
      actorCredentialHash: intent.actorCredentialHash!,
      candidate,
      candidateHash: credentialHash(candidate),
      operationId,
      kind,
      expectedVersion: binding.version,
      revision: binding.intentRevision,
      deadline: new Date(Math.min(intent.expiresAt.getTime(), admitted.session.expiresAt.getTime())),
    }),
  );
  return preparation;
}

/** Call after the real mutation, before committing the SAME outer transaction.
 * Every refusal throws so callers cannot commit a partial credential mutation. */
export async function commitPreparedBrowserReplacementInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  preparation: BrowserReplacementPreparation,
  mutationReceipt: IdentityGenerationMutationReceipt,
): Promise<Extract<BrowserBindingCommitResult, { status: 'committed' | 'already-committed' }>> {
  const prepared =
    typeof preparation === 'object' && preparation !== null ? preparedReplacements.get(preparation) : undefined;
  if (!prepared || prepared.transaction !== transaction || prepared.authority !== authority)
    throw new Error('BROWSER_REPLACEMENT_PREPARATION_INVALID');
  const generations = requireFirstPartyContinuationMutationReceipt(
    transaction,
    prepared.source.userId,
    mutationReceipt,
    { operationId: prepared.operationId, kind: prepared.kind },
  );
  if (
    generations.previousGeneration !== prepared.source.generation ||
    generations.generation !== prepared.source.generation + 1
  )
    throw new Error('BROWSER_REPLACEMENT_MUTATION_MISMATCH');
  await revalidateIdentityAuthority(transaction, authority);
  const [binding] = await transaction
    .select()
    .from(authBrowserBindings)
    .where(eq(authBrowserBindings.id, prepared.bindingId))
    .for('update');
  const [intent] = await transaction
    .select()
    .from(authBrowserIntents)
    .where(eq(authBrowserIntents.id, prepared.intentId))
    .for('update');
  const now = await databaseNow(transaction);
  if (
    !binding ||
    !intent ||
    !intentMatches(intent, binding, authority, now) ||
    intent.operation !== 'replacement' ||
    intent.consumedAt ||
    intent.expectedVersion !== prepared.expectedVersion ||
    binding.version !== prepared.expectedVersion ||
    binding.intentRevision !== prepared.revision ||
    intent.actorCredentialHash !== prepared.actorCredentialHash ||
    prepared.deadline.getTime() <= now.getTime()
  )
    throw new Error('BROWSER_REPLACEMENT_PREPARATION_STALE');
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, prepared.source.userId));
  const [event] = await transaction
    .select()
    .from(authSecurityMutationEvents)
    .where(eq(authSecurityMutationEvents.operationId, prepared.operationId));
  if (
    !cutoff ||
    cutoff.deletedAt ||
    cutoff.lastOperationId !== prepared.operationId ||
    cutoff.generation !== generations.generation ||
    !event ||
    event.userId !== prepared.source.userId ||
    event.kind !== prepared.kind ||
    event.projectionId !== authority.projectionId ||
    event.writerEpoch !== authority.epoch ||
    event.previousGeneration !== generations.previousGeneration ||
    event.generation !== generations.generation
  )
    throw new Error('BROWSER_REPLACEMENT_MUTATION_MISMATCH');
  const admitted = await readFirstPartySession(transaction, prepared.candidate, now, (userId) =>
    readLockedWebSubjectState(transaction, userId),
  );
  if (admitted.status !== 'admitted') throw new Error('BROWSER_REPLACEMENT_CANDIDATE_REFUSED');
  const candidate = admitted.session;
  if (
    binding.credentialKind !== prepared.candidate.kind ||
    candidate.userId !== prepared.source.userId ||
    candidate.authSessionId !== prepared.source.authSessionId ||
    candidate.generation !== generations.generation ||
    candidate.authenticatedAt?.getTime() !== prepared.source.authenticatedAt?.getTime() ||
    candidate.linkGuarded !== prepared.source.linkGuarded ||
    candidate.requiresAccountCutoff !== prepared.source.requiresAccountCutoff ||
    candidate.expiresAt.getTime() > prepared.source.expiresAt.getTime()
  )
    throw new Error('BROWSER_REPLACEMENT_CANDIDATE_MISMATCH');
  const result = await applySelection(
    transaction,
    binding,
    intent,
    candidate,
    now,
    prepared.candidate.kind,
    prepared.candidateHash,
  );
  await revalidateIdentityAuthority(transaction, authority);
  const finished = await databaseNow(transaction);
  if (finished.getTime() >= prepared.deadline.getTime() || finished.getTime() >= candidate.expiresAt.getTime())
    throw new Error('BROWSER_REPLACEMENT_PREPARATION_STALE');
  preparedReplacements.delete(preparation);
  return result;
}
