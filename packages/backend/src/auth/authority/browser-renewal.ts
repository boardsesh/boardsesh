import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  authBrowserBindings,
  authBrowserIntents,
  authBrowserRenewals,
  authCredentialLineage,
  authSession,
} from '@boardsesh/db/schema/auth';
import {
  browserRenewalCommandSchema,
  browserRenewalPreparationSchema,
  browserRenewalReplySchema,
  type BrowserRenewalCommand,
  type BrowserRenewalPreparation,
  type BrowserRenewalReply,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityQualification,
  type IdentityAuthorityReceipt,
} from './router';
import { readBrowserBindingInTransaction } from './browser-binding';
import { readFirstPartySession, type FirstPartyCredential, type FirstPartySession } from './session-reader';
import { readLockedWebSubjectState } from '../current-store/web-credential-state';
import { transactionSettings } from '../current-store/command-context';
import { providerDatabaseNow } from './provider-security-context';

export interface BrowserRenewalRuntime {
  readonly qualification: IdentityAuthorityQualification;
  readonly legacySecret?: string;
}
type Actor = BrowserRenewalCommand['payload']['actor'];
type Bound = Extract<BrowserRenewalCommand, { operation: 'finalize' }>['payload'];
type OperationRow = typeof authBrowserRenewals.$inferSelect;
class Refusal extends Error {
  constructor(readonly outcome: 'conflict' | 'denied' | 'unavailable') {
    super(outcome);
  }
}
const refuse = (outcome: Refusal['outcome'] = 'conflict'): never => {
  throw new Refusal(outcome);
};
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const tokenHash = (token: string) => hash(['browser-renewal-token-v1', token]);
const credentialHash = (credential: Actor['credential']) => hash(['browser-renewal-source-v1', credential]);
const metadataHash = (preparation: BrowserRenewalPreparation) => hash(['browser-renewal-preparation-v1', preparation]);
const iso = (date: Date) => date.toISOString();
function sourceCredential(actor: Actor, runtime: BrowserRenewalRuntime): FirstPartyCredential {
  if (actor.credential.kind === 'canonical-token') return { ...actor.credential };
  if (!runtime.legacySecret) return refuse('unavailable');
  return { ...actor.credential, secret: runtime.legacySecret };
}
function proof(session: FirstPartySession) {
  return {
    version: 1 as const,
    userId: session.userId,
    authSessionId: session.authSessionId,
    generation: session.generation,
    authenticatedAt: session.authenticatedAt ? iso(session.authenticatedAt) : null,
    linkGuarded: session.linkGuarded,
    ...(session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
  };
}
function sameProvenance(session: FirstPartySession, expected: BrowserRenewalPreparation['sourceCredentialProof']) {
  return (
    session.userId === expected.userId &&
    session.authSessionId === expected.authSessionId &&
    session.generation === expected.generation &&
    (session.authenticatedAt ? iso(session.authenticatedAt) : null) === expected.authenticatedAt &&
    session.linkGuarded === expected.linkGuarded &&
    session.requiresAccountCutoff === Boolean(expected.requiresAccountCutoff)
  );
}
async function selected(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  bindingToken: string,
  actor: Actor,
  runtime: BrowserRenewalRuntime,
) {
  const admitted = await readBrowserBindingInTransaction(transaction, authority, {
    bindingToken,
    actor: { version: actor.version, credential: sourceCredential(actor, runtime) },
  });
  if (admitted.status !== 'admitted') return refuse(admitted.status === 'unavailable' ? 'unavailable' : 'conflict');
  const [binding] = await transaction
    .select()
    .from(authBrowserBindings)
    .where(eq(authBrowserBindings.id, admitted.cursor.bindingId))
    .for('update');
  if (!binding || binding.version !== admitted.cursor.version) return refuse();
  return { ...admitted, binding };
}
async function noPendingAccountChange(
  transaction: AuthorityTransaction,
  binding: typeof authBrowserBindings.$inferSelect,
  now: Date,
) {
  const [pending] = await transaction
    .select({ id: authBrowserIntents.id })
    .from(authBrowserIntents)
    .where(
      and(
        eq(authBrowserIntents.bindingId, binding.id),
        eq(authBrowserIntents.expectedVersion, binding.version),
        eq(authBrowserIntents.revision, binding.intentRevision),
        isNull(authBrowserIntents.consumedAt),
        gt(authBrowserIntents.expiresAt, now),
      ),
    );
  if (pending) return refuse();
}
async function prepare(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  runtime: BrowserRenewalRuntime,
  input: Extract<BrowserRenewalCommand, { operation: 'prepare' }>['payload'],
) {
  const current = await selected(transaction, authority, input.bindingToken, input.actor, runtime);
  const now = await providerDatabaseNow(transaction);
  await noPendingAccountChange(transaction, current.binding, now);
  const target = new Date((Math.floor(now.getTime() / 1_000) + 30 * 24 * 60 * 60) * 1_000);
  const expiresAt = new Date(
    Math.min(now.getTime() + 60_000, current.session.expiresAt.getTime(), current.cursor.bindingExpiresAt.getTime()),
  );
  if (
    expiresAt.getTime() <= now.getTime() ||
    current.cursor.version >= 2_147_483_647 ||
    target.getTime() < current.session.expiresAt.getTime()
  )
    return refuse();
  const preparation = browserRenewalPreparationSchema.parse({
    version: 1,
    credentialKind: input.actor.credential.kind,
    sourceCredentialProof: proof(current.session),
    sourceCredentialHash: credentialHash(input.actor.credential),
    sourceExpiresAt: iso(current.session.expiresAt),
    browserCursor: { ...current.cursor, bindingExpiresAt: iso(current.cursor.bindingExpiresAt) },
    intentRevision: current.binding.intentRevision,
    futureBrowserCursor: {
      bindingId: current.cursor.bindingId,
      version: current.cursor.version + 1,
      bindingExpiresAt: iso(new Date(Math.max(target.getTime(), current.cursor.bindingExpiresAt.getTime()))),
    },
    targetExpiresAt: iso(target),
    preparedAt: iso(now),
    expiresAt: iso(expiresAt),
  });
  const operationToken = randomBytes(32).toString('base64url');
  const preparationToken = randomBytes(32).toString('base64url');
  await transaction.insert(authBrowserRenewals).values({
    operationHash: tokenHash(operationToken),
    preparationHash: tokenHash(preparationToken),
    nonceHash: input.nonceHash,
    bindingId: current.cursor.bindingId,
    bindingVersion: current.cursor.version,
    intentRevision: current.binding.intentRevision,
    actorCredentialHash: preparation.sourceCredentialHash,
    userId: current.session.userId,
    authSessionId: current.session.authSessionId,
    projectionId: authority.projectionId,
    normalizerVersion: authority.normalizerVersion,
    authority: authority.authority,
    epoch: authority.epoch,
    preparation,
    metadataHash: metadataHash(preparation),
    preparedAt: now,
    expiresAt,
  });
  if ((await providerDatabaseNow(transaction)).getTime() >= expiresAt.getTime()) return refuse();
  return { outcome: 'prepared' as const, operationToken, preparationToken, preparation };
}
async function operation(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  input: Bound,
): Promise<OperationRow> {
  const [stored] = await transaction
    .select()
    .from(authBrowserRenewals)
    .where(eq(authBrowserRenewals.operationHash, tokenHash(input.operationToken)))
    .for('update');
  if (
    !stored ||
    stored.preparationHash !== tokenHash(input.preparationToken) ||
    stored.nonceHash !== input.nonceHash ||
    stored.actorCredentialHash !== credentialHash(input.actor.credential) ||
    stored.metadataHash !== metadataHash(input.preparation) ||
    metadataHash(browserRenewalPreparationSchema.parse(stored.preparation)) !== stored.metadataHash ||
    stored.bindingId !== hashBinding(input.bindingToken) ||
    stored.bindingVersion !== input.actor.version ||
    stored.userId !== input.preparation.sourceCredentialProof.userId ||
    stored.authSessionId !== input.preparation.sourceCredentialProof.authSessionId ||
    stored.projectionId !== authority.projectionId ||
    stored.normalizerVersion !== authority.normalizerVersion ||
    stored.authority !== authority.authority ||
    stored.epoch !== authority.epoch
  )
    return refuse();
  return stored;
}
function hashBinding(bindingToken: string) {
  return createHash('sha256').update(bindingToken).digest('hex');
}
async function renewCanonicalMirror(
  transaction: AuthorityTransaction,
  expected: BrowserRenewalPreparation,
  actor: Actor,
  now: Date,
) {
  const [session] = await transaction
    .select()
    .from(authSession)
    .where(eq(authSession.id, expected.sourceCredentialProof.authSessionId))
    .for('update');
  if (!session) {
    if (actor.credential.kind === 'canonical-token') return refuse();
    return;
  }
  const provenance = expected.sourceCredentialProof;
  const target = new Date(expected.targetExpiresAt);
  if (
    session.userId !== provenance.userId ||
    (session.revocationGeneration ?? 0) !== provenance.generation ||
    (session.originalAuthenticatedAt ? iso(session.originalAuthenticatedAt) : null) !== provenance.authenticatedAt ||
    Boolean(session.legacyLineageId?.startsWith('credential:')) !== Boolean(provenance.requiresAccountCutoff) ||
    session.expiresAt.getTime() <= now.getTime() ||
    session.expiresAt.getTime() > target.getTime() ||
    (actor.credential.kind === 'canonical-token' && session.token !== actor.credential.token)
  )
    return refuse();
  if (session.legacyLineageId) {
    const [lineage] = await transaction
      .select()
      .from(authCredentialLineage)
      .where(eq(authCredentialLineage.id, session.legacyLineageId))
      .for('update');
    if (!lineage || lineage.revokedAt || lineage.userId !== session.userId || lineage.sessionId !== session.id)
      return refuse();
  }
  const [updated] = await transaction
    .update(authSession)
    .set({ expiresAt: target, updatedAt: now })
    .where(and(eq(authSession.id, session.id), eq(authSession.token, session.token)))
    .returning({ id: authSession.id });
  if (!updated) return refuse();
}
async function finalize(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  runtime: BrowserRenewalRuntime,
  input: Bound,
) {
  // Gate → selected user/binding → renewal row → canonical session/lineage.
  const current = await selected(transaction, authority, input.bindingToken, input.actor, runtime);
  const stored = await operation(transaction, authority, input);
  const preparation = input.preparation;
  const now = await providerDatabaseNow(transaction);
  if (
    stored.completedAt ||
    stored.expiresAt.getTime() <= now.getTime() ||
    stored.intentRevision !== current.binding.intentRevision ||
    current.cursor.version !== preparation.browserCursor.version ||
    current.cursor.bindingId !== preparation.browserCursor.bindingId ||
    iso(current.cursor.bindingExpiresAt) !== preparation.browserCursor.bindingExpiresAt ||
    !sameProvenance(current.session, preparation.sourceCredentialProof) ||
    iso(current.session.expiresAt) !== preparation.sourceExpiresAt ||
    preparation.credentialKind !== input.actor.credential.kind ||
    input.candidate.kind !== input.actor.credential.kind
  )
    return refuse();
  await noPendingAccountChange(transaction, current.binding, now);
  if (
    input.actor.credential.kind === 'canonical-token' &&
    (input.candidate.kind !== 'canonical-token' || input.candidate.token !== input.actor.credential.token)
  )
    return refuse();
  await renewCanonicalMirror(transaction, preparation, input.actor, now);
  const candidate = sourceCredential({ version: input.actor.version + 1, credential: input.candidate }, runtime);
  const admitted = await readFirstPartySession(transaction, candidate, now, (userId) =>
    readLockedWebSubjectState(transaction, userId),
  );
  if (
    admitted.status !== 'admitted' ||
    !sameProvenance(admitted.session, preparation.sourceCredentialProof) ||
    iso(admitted.session.expiresAt) !== preparation.targetExpiresAt
  )
    return refuse();
  const [updated] = await transaction
    .update(authBrowserBindings)
    .set({
      version: input.actor.version + 1,
      credentialExpiresAt: new Date(preparation.targetExpiresAt),
      expiresAt: new Date(preparation.futureBrowserCursor.bindingExpiresAt),
    })
    .where(
      and(
        eq(authBrowserBindings.id, stored.bindingId),
        eq(authBrowserBindings.version, stored.bindingVersion),
        eq(authBrowserBindings.intentRevision, stored.intentRevision),
      ),
    )
    .returning();
  if (!updated) return refuse();
  const acknowledgeUntil = new Date(
    Math.min(
      now.getTime() + 300_000,
      Date.parse(preparation.sourceExpiresAt),
      Date.parse(preparation.browserCursor.bindingExpiresAt),
    ),
  );
  await transaction
    .update(authBrowserRenewals)
    .set({
      candidateHash: credentialHash(input.candidate),
      resultVersion: updated.version,
      completedAt: now,
      acknowledgeUntil,
    })
    .where(eq(authBrowserRenewals.operationHash, stored.operationHash));
  const finished = await providerDatabaseNow(transaction);
  if (
    finished.getTime() >= Math.min(stored.expiresAt.getTime(), acknowledgeUntil.getTime()) ||
    finished.getTime() >= Date.parse(preparation.sourceExpiresAt)
  )
    return refuse();
  await revalidateIdentityAuthority(transaction, authority);
  const final = await readFirstPartySession(transaction, candidate, finished, (userId) =>
    readLockedWebSubjectState(transaction, userId),
  );
  if (
    final.status !== 'admitted' ||
    !sameProvenance(final.session, preparation.sourceCredentialProof) ||
    iso(final.session.expiresAt) !== preparation.targetExpiresAt
  )
    return refuse();
  return {
    outcome: 'completed' as const,
    cursor: preparation.futureBrowserCursor,
    credentialProof: preparation.sourceCredentialProof,
    credentialExpiresAt: preparation.targetExpiresAt,
  };
}

async function acknowledge(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  runtime: BrowserRenewalRuntime,
  input: Bound,
) {
  const preparation = input.preparation;
  const current = await selected(
    transaction,
    authority,
    input.bindingToken,
    { version: preparation.futureBrowserCursor.version, credential: input.candidate },
    runtime,
  );
  const stored = await operation(transaction, authority, input);
  const now = await providerDatabaseNow(transaction);
  if (
    !stored.completedAt ||
    !stored.acknowledgeUntil ||
    stored.acknowledgeUntil.getTime() <= now.getTime() ||
    stored.resultVersion !== current.cursor.version ||
    stored.candidateHash !== credentialHash(input.candidate) ||
    current.cursor.version !== input.actor.version + 1 ||
    current.cursor.version !== preparation.futureBrowserCursor.version ||
    current.cursor.bindingId !== preparation.futureBrowserCursor.bindingId ||
    iso(current.cursor.bindingExpiresAt) !== preparation.futureBrowserCursor.bindingExpiresAt ||
    iso(current.session.expiresAt) !== preparation.targetExpiresAt ||
    !sameProvenance(current.session, preparation.sourceCredentialProof) ||
    input.candidate.kind !== preparation.credentialKind ||
    input.actor.credential.kind !== preparation.credentialKind
  )
    return refuse();
  const original = await readFirstPartySession(transaction, sourceCredential(input.actor, runtime), now, (userId) =>
    readLockedWebSubjectState(transaction, userId),
  );
  if (
    original.status !== 'admitted' ||
    !sameProvenance(original.session, preparation.sourceCredentialProof) ||
    Date.parse(preparation.sourceExpiresAt) <= now.getTime() ||
    original.session.expiresAt.getTime() < Date.parse(preparation.sourceExpiresAt) ||
    (input.actor.credential.kind === 'legacy-jwe' && iso(original.session.expiresAt) !== preparation.sourceExpiresAt)
  )
    return refuse();
  return {
    outcome: 'completed' as const,
    cursor: preparation.futureBrowserCursor,
    credentialProof: preparation.sourceCredentialProof,
    credentialExpiresAt: preparation.targetExpiresAt,
  };
}

/** Backend-only transaction seam. Uncertain outcomes are never internally
 * retried; a refused post-write check throws so Drizzle rolls back everything. */
export async function executeBrowserRenewalCommand(
  database: AuthorityDatabase,
  runtimeInput: BrowserRenewalRuntime,
  commandInput: BrowserRenewalCommand,
): Promise<BrowserRenewalReply> {
  const command = browserRenewalCommandSchema.parse(commandInput);
  const runtime: BrowserRenewalRuntime = Object.freeze({
    qualification: Object.freeze({ ...runtimeInput.qualification }),
    legacySecret: runtimeInput.legacySecret,
  });
  try {
    const result = await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const authority = await captureIdentityAuthority(transaction, runtime.qualification);
      const reply =
        command.operation === 'prepare'
          ? await prepare(transaction, authority, runtime, command.payload)
          : command.operation === 'acknowledge'
            ? await acknowledge(transaction, authority, runtime, command.payload)
            : await finalize(transaction, authority, runtime, command.payload);
      await revalidateIdentityAuthority(transaction, authority);
      // Authority/catalog reads may themselves wait. The last command action
      // is a fresh database clock fence, after every write and admission await.
      const operationToken =
        command.operation === 'prepare'
          ? reply.outcome === 'prepared'
            ? reply.operationToken
            : ''
          : command.payload.operationToken;
      const [durable] = await transaction
        .select({ expiresAt: authBrowserRenewals.expiresAt, until: authBrowserRenewals.acknowledgeUntil })
        .from(authBrowserRenewals)
        .where(eq(authBrowserRenewals.operationHash, tokenHash(operationToken)));
      const finished = await providerDatabaseNow(transaction);
      const deadline =
        command.operation === 'prepare'
          ? reply.outcome === 'prepared'
            ? Math.min(Date.parse(reply.preparation.expiresAt), durable?.expiresAt.getTime() ?? 0)
            : 0
          : Math.min(
              Date.parse(command.payload.preparation.sourceExpiresAt),
              Date.parse(command.payload.preparation.browserCursor.bindingExpiresAt),
              command.operation === 'finalize'
                ? Math.min(Date.parse(command.payload.preparation.expiresAt), durable?.expiresAt.getTime() ?? 0)
                : (durable?.until?.getTime() ?? 0),
            );
      if (finished.getTime() >= deadline) return refuse();
      return reply;
    });
    return browserRenewalReplySchema.parse({
      browserRenewalProtocolVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      ...result,
    });
  } catch (error) {
    return browserRenewalReplySchema.parse({
      browserRenewalProtocolVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      outcome: error instanceof Refusal ? error.outcome : 'unavailable',
    });
  }
}
