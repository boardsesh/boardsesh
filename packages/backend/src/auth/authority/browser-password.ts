import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  authBrowserBindings,
  authBrowserIntents,
  authSession,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import {
  BROWSER_PASSWORD_ACK_MS,
  BROWSER_PASSWORD_CREDENTIAL_SECONDS,
  BROWSER_PASSWORD_PREPARATION_MS,
  BROWSER_PASSWORD_RESPONSE_BYTES,
  browserPasswordCommandSchema,
  browserPasswordPreparationSchema,
  browserPasswordReplySchema,
  type BrowserPasswordCommand,
  type BrowserPasswordPreparation,
  type BrowserPasswordReply,
  type BrowserPasswordSource,
} from '@boardsesh/auth-protocol/browser-password-v1';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  beginBrowserLoginInTransaction,
  commitBrowserLoginInTransaction,
  readBrowserBindingInTransaction,
  type BrowserSelectionCredential,
} from './browser-binding';
import { captureIdentityAuthority, revalidateIdentityAuthority } from './router';
import { providerDatabaseNow } from './provider-security-context';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import { readFirstPartySession, type FirstPartyCredential } from './session-reader';
import { readLockedWebSubjectState } from '../current-store/web-credential-state';
import {
  lockWebPasswordAuthentication,
  prepareWebPasswordAuthentication,
  readWebPasswordCandidateInTransaction,
} from '../current-store/web-password';
import {
  assertFresh,
  boundSignInLockWaits,
  captureAuthority,
  claimCommand,
  transactionSettings,
  type WebPasswordAuthority,
} from '../current-store/command-context';
import { issueWebCredentialProof } from '../current-store/web-credential-proof';
import {
  BROWSER_PASSWORD_RECEIPT_PREFIX,
  browserPasswordCredentialHash,
  browserPasswordHash,
  browserPasswordProof,
  browserPasswordReceiptHash,
  browserPasswordStateHash,
  browserPasswordTokenHash,
  sameBrowserPasswordAuthority,
  sameBrowserPasswordSession,
} from './browser-password-policy';

export { BROWSER_PASSWORD_RECEIPT_PREFIX } from './browser-password-policy';
export const BROWSER_PASSWORD_PUBLIC_READY = false;
export interface BrowserPasswordRuntime {
  readonly authority: WebPasswordAuthority;
  readonly legacySecret?: string;
}
type Failure = 'denied' | 'conflict' | 'unavailable';
class BrowserPasswordRefusal extends Error {
  constructor(readonly outcome: Failure) {
    super('Browser password command refused');
  }
}
function refuse(outcome: Failure): never {
  throw new BrowserPasswordRefusal(outcome);
}
function checkedReply(reply: BrowserPasswordReply): BrowserPasswordReply {
  const parsed = browserPasswordReplySchema.parse(reply);
  if (Buffer.byteLength(JSON.stringify(parsed)) > BROWSER_PASSWORD_RESPONSE_BYTES) refuse('unavailable');
  return parsed;
}
function actualCredential(
  presented:
    | BrowserSelectionCredential['credential']
    | Extract<BrowserPasswordCommand, { operation: 'finalize' }>['payload']['candidate'],
  legacySecret: string | undefined,
): FirstPartyCredential {
  if (presented.kind === 'canonical-token') return { kind: presented.kind, token: presented.token };
  if (!legacySecret) return refuse('unavailable');
  return { kind: presented.kind, credential: presented.credential, secret: legacySecret };
}
function sourceActor(
  source: BrowserPasswordSource,
  legacySecret: string | undefined,
): BrowserSelectionCredential | undefined {
  return source.state === 'selected'
    ? { version: source.actor.version, credential: actualCredential(source.actor.credential, legacySecret) }
    : undefined;
}
function assertClock(preparation: BrowserPasswordPreparation, now: Date, acknowledge = false) {
  if (
    now.getTime() < Date.parse(preparation.preparedAt) ||
    now.getTime() >= Date.parse(acknowledge ? preparation.acknowledgeUntil : preparation.expiresAt) ||
    now.getTime() >= Date.parse(preparation.futureBrowserCursor.bindingExpiresAt) ||
    now.getTime() >= Date.parse(preparation.credentialExpiresAt)
  )
    refuse('conflict');
}
async function preciseBindingState(transaction: AuthorityTransaction, bindingId: string) {
  const [row] = await transaction
    .select({ state: sql<string>`to_jsonb(${authBrowserBindings})::text` })
    .from(authBrowserBindings)
    .where(eq(authBrowserBindings.id, bindingId));
  if (!row) return refuse('conflict');
  return browserPasswordHash(['browser-password-prepared-state-v1', row.state]);
}
async function lockUsers(transaction: AuthorityTransaction, userIds: readonly string[]) {
  await boundSignInLockWaits(transaction);
  await transaction
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, [...new Set(userIds)]))
    .orderBy(users.id)
    .for('update');
}
function assertBoundSource(
  source: BrowserPasswordSource,
  preparation: BrowserPasswordPreparation,
  legacySecret: string | undefined,
) {
  if (browserPasswordTokenHash(source.bindingToken) !== preparation.browserCursor.bindingId) refuse('conflict');
  if (source.state === 'selected' && preparation.source.state === 'selected') {
    const credential = actualCredential(source.actor.credential, legacySecret);
    if (browserPasswordCredentialHash(credential) !== preparation.source.credentialHash) refuse('conflict');
  }
}
async function assertCandidate(
  transaction: AuthorityTransaction,
  preparation: BrowserPasswordPreparation,
  credential: FirstPartyCredential,
  now: Date,
  requireStored: boolean,
) {
  if (credential.kind === 'canonical-token') {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(credential.token) ||
      browserPasswordCredentialHash(credential) !== preparation.proposedCanonicalTokenHash
    )
      refuse('denied');
    if (!requireStored) return;
  } else {
    const proof = await verifyLegacyNextAuthJwe(credential.credential, credential.secret, now);
    const expected = preparation.credentialProof;
    if (
      !proof ||
      proof.userId !== expected.userId ||
      proof.authSessionId !== expected.authSessionId ||
      proof.generation !== expected.generation ||
      proof.linkGuarded !== true ||
      proof.requiresAccountCutoff ||
      proof.originalAuthenticatedAt?.toISOString() !== expected.authenticatedAt ||
      proof.expiresAt.toISOString() !== preparation.credentialExpiresAt
    )
      refuse('denied');
  }
  const admitted = await readFirstPartySession(transaction, credential, now, (userId) =>
    userId === preparation.credentialProof.userId
      ? readLockedWebSubjectState(transaction, userId)
      : Promise.resolve(undefined),
  );
  if (admitted.status !== 'admitted') refuse(admitted.status);
  if (!sameBrowserPasswordSession(admitted.session, preparation.credentialProof, preparation.credentialExpiresAt))
    refuse('denied');
}
function completedReply(
  metadata: { browserPasswordProtocolVersion: 1; requestId: string },
  operation: 'finalize' | 'acknowledge',
  preparation: BrowserPasswordPreparation,
  credential: FirstPartyCredential,
): BrowserPasswordReply {
  return checkedReply({
    ...metadata,
    operation,
    outcome: 'completed',
    cursor: preparation.futureBrowserCursor,
    candidateCredentialHash: browserPasswordCredentialHash(credential),
    credentialProof: preparation.credentialProof,
    credentialExpiresAt: preparation.credentialExpiresAt,
  });
}

/** Private staging only. No public callback or response is published here. */
export async function executeBrowserPasswordCommand(
  database: AuthorityDatabase,
  runtimeInput: BrowserPasswordRuntime,
  input: BrowserPasswordCommand,
): Promise<BrowserPasswordReply> {
  const runtime = { authority: captureAuthority(runtimeInput.authority), legacySecret: runtimeInput.legacySecret };
  const command = browserPasswordCommandSchema.parse(input);
  const metadata = { browserPasswordProtocolVersion: 1 as const, requestId: command.requestId };
  try {
    if (process.env.DEBUG_SQL === 'true') return refuse('unavailable');
    assertFresh(command.issuedAt);
    if (command.operation === 'prepare') {
      const { source, email, password, credentialKind, nonceHash } = command.payload;
      if (credentialKind === 'legacy-jwe' && !runtime.legacySecret) refuse('unavailable');
      const verified = await prepareWebPasswordAuthentication(database, runtime.authority, email, password);
      return await database.transaction(async (transaction): Promise<BrowserPasswordReply> => {
        await transactionSettings(transaction);
        await revalidateIdentityAuthority(transaction, verified.receipt);
        if (
          !(await claimCommand(transaction, {
            requestId: command.requestId,
            issuedAt: command.issuedAt,
            operation: 'password',
          }))
        )
          refuse('conflict');
        assertFresh(command.issuedAt);
        if (verified.matchedUserId === null)
          return { ...metadata, operation: 'prepare', outcome: 'invalid_credentials' };
        const [observed] = await transaction
          .select()
          .from(authBrowserBindings)
          .where(eq(authBrowserBindings.id, browserPasswordTokenHash(source.bindingToken)));
        if (!observed) refuse('denied');
        if ((source.state === 'anonymous') !== (observed.userId === null)) refuse('conflict');
        const selected = await lockWebPasswordAuthentication(
          transaction,
          verified,
          observed.userId ? [observed.userId] : [],
        );
        assertFresh(command.issuedAt);
        if (!selected) return { ...metadata, operation: 'prepare', outcome: 'invalid_credentials' };
        const rawProof = await issueWebCredentialProof(transaction, selected.userId, 1, selected.generation);
        if (!rawProof?.authenticatedAt) refuse('unavailable');
        const credentialProof = {
          ...rawProof,
          authenticatedAt: new Date(Math.floor(Date.parse(rawProof.authenticatedAt) / 1_000) * 1_000).toISOString(),
        };
        const intent = await beginBrowserLoginInTransaction(transaction, verified.receipt, {
          bindingToken: source.bindingToken,
          expectedVersion: source.expectedVersion,
          expectedSourceUserId: observed.userId,
          actor: sourceActor(source, runtime.legacySecret),
          maximumLifetimeMs: BROWSER_PASSWORD_PREPARATION_MS,
        });
        if (intent.status !== 'prepared') refuse(intent.status);
        const proposedCanonicalToken =
          credentialKind === 'canonical-token' ? randomBytes(32).toString('base64url') : null;
        const cursor = { ...intent.cursor, bindingExpiresAt: intent.cursor.bindingExpiresAt.toISOString() };
        const preparation = browserPasswordPreparationSchema.parse({
          version: 1,
          purpose: 'browser-password-publication-v1',
          source:
            intent.sourceSession && source.state === 'selected'
              ? {
                  state: 'selected',
                  credentialKind: source.actor.credential.kind,
                  credentialHash: browserPasswordCredentialHash(
                    actualCredential(source.actor.credential, runtime.legacySecret),
                  ),
                  credentialProof: browserPasswordProof(intent.sourceSession),
                  expiresAt: intent.sourceSession.expiresAt.toISOString(),
                }
              : { state: 'anonymous' },
          browserCursor: cursor,
          sourceIntentRevision: intent.sourceIntentRevision,
          intentRevision: intent.intentRevision,
          preparedStateHash: intent.preparedStateHash,
          futureBrowserCursor: { ...cursor, version: cursor.version + 1 },
          authority: verified.receipt,
          nonceHash,
          passwordStateHash: browserPasswordStateHash(selected),
          credentialKind,
          passwordVerifiedAt: rawProof.authenticatedAt,
          credentialProof,
          credentialExpiresAt: new Date(
            Date.parse(credentialProof.authenticatedAt) + BROWSER_PASSWORD_CREDENTIAL_SECONDS * 1_000,
          ).toISOString(),
          proposedCanonicalTokenHash: proposedCanonicalToken
            ? browserPasswordCredentialHash({ kind: 'canonical-token', token: proposedCanonicalToken })
            : null,
          verification: {
            required: runtime.authority.emailVerificationEnabled,
            verified: selected.emailVerified !== null,
          },
          preparedAt: intent.preparedAt.toISOString(),
          expiresAt: intent.expiresAt.toISOString(),
          acknowledgeUntil: new Date(intent.preparedAt.getTime() + BROWSER_PASSWORD_ACK_MS).toISOString(),
        });
        const operationToken = randomBytes(32).toString('base64url');
        await transaction.insert(verificationTokens).values({
          identifier: BROWSER_PASSWORD_RECEIPT_PREFIX + browserPasswordTokenHash(operationToken),
          token: browserPasswordReceiptHash(operationToken, intent.intentToken, preparation, 'prepared'),
          expires: new Date(preparation.acknowledgeUntil),
        });
        await revalidateIdentityAuthority(transaction, verified.receipt);
        assertFresh(command.issuedAt);
        assertClock(preparation, await providerDatabaseNow(transaction));
        return checkedReply({
          ...metadata,
          operation: 'prepare',
          outcome: 'prepared',
          operationToken,
          browserIntentToken: intent.intentToken,
          preparation,
          proposedCanonicalToken,
          user: { id: selected.userId, email: selected.email, name: selected.name, image: selected.image },
        });
      });
    }
    return await database.transaction(async (transaction): Promise<BrowserPasswordReply> => {
      await transactionSettings(transaction);
      const authority = await captureIdentityAuthority(transaction, runtime.authority);
      const { source, operationToken, browserIntentToken, preparation } = command.payload;
      if (
        !sameBrowserPasswordAuthority(preparation, authority) ||
        preparation.verification.required !== runtime.authority.emailVerificationEnabled
      )
        refuse('conflict');
      assertBoundSource(source, preparation, runtime.legacySecret);
      const targetId = preparation.credentialProof.userId;
      const sourceId = preparation.source.state === 'selected' ? preparation.source.credentialProof.userId : null;
      // ACK never admits or locks the expired source. It only owns the target.
      await lockUsers(
        transaction,
        command.operation === 'acknowledge' ? [targetId] : [targetId, ...(sourceId ? [sourceId] : [])],
      );
      const [binding] = await transaction
        .select()
        .from(authBrowserBindings)
        .where(eq(authBrowserBindings.id, preparation.browserCursor.bindingId))
        .for('update');
      if (!binding) refuse('conflict');
      const identifier = BROWSER_PASSWORD_RECEIPT_PREFIX + browserPasswordTokenHash(operationToken);
      const receipts = await transaction
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, identifier))
        .for('update');
      if (receipts.length !== 1 || receipts[0].expires.toISOString() !== preparation.acknowledgeUntil)
        refuse('conflict');
      const receipt = receipts[0];
      const now = await providerDatabaseNow(transaction);
      const preparedHash = browserPasswordReceiptHash(operationToken, browserIntentToken, preparation, 'prepared');
      if (command.operation === 'acknowledge') {
        assertClock(preparation, now, true);
        const credential = actualCredential(command.payload.candidate, runtime.legacySecret);
        const completedHash = browserPasswordReceiptHash(
          operationToken,
          browserIntentToken,
          preparation,
          'completed',
          browserPasswordCredentialHash(credential),
        );
        if (
          receipt.token !== completedHash ||
          binding.userId !== targetId ||
          binding.version !== preparation.futureBrowserCursor.version ||
          binding.intentRevision !== preparation.intentRevision ||
          binding.expiresAt.toISOString() !== preparation.futureBrowserCursor.bindingExpiresAt
        )
          refuse('conflict');
        await assertCandidate(transaction, preparation, credential, now, true);
        const admitted = await readBrowserBindingInTransaction(transaction, authority, {
          bindingToken: source.bindingToken,
          actor: { version: preparation.futureBrowserCursor.version, credential },
        });
        if (admitted.status !== 'admitted') refuse(admitted.status === 'anonymous' ? 'conflict' : admitted.status);
        if (!sameBrowserPasswordSession(admitted.session, preparation.credentialProof, preparation.credentialExpiresAt))
          refuse('conflict');
        await revalidateIdentityAuthority(transaction, authority);
        assertFresh(command.issuedAt);
        assertClock(preparation, await providerDatabaseNow(transaction), true);
        return completedReply(metadata, 'acknowledge', preparation, credential);
      }
      if (
        receipt.token !== preparedHash ||
        binding.version !== preparation.browserCursor.version ||
        binding.userId !== sourceId ||
        binding.intentRevision !== preparation.intentRevision ||
        (await preciseBindingState(transaction, binding.id)) !== preparation.preparedStateHash
      )
        refuse('conflict');
      const [intent] = await transaction
        .select()
        .from(authBrowserIntents)
        .where(eq(authBrowserIntents.id, browserPasswordTokenHash(browserIntentToken)))
        .for('update');
      if (
        !intent ||
        intent.bindingId !== binding.id ||
        intent.revision !== preparation.intentRevision ||
        intent.expectedVersion !== binding.version ||
        intent.operation !== 'login' ||
        intent.formatVersion !== 2 ||
        intent.consumedAt !== null ||
        intent.resultVersion !== null ||
        intent.resultCredentialHash !== null ||
        intent.projectionId !== authority.projectionId ||
        intent.authority !== authority.authority ||
        intent.epoch !== authority.epoch ||
        intent.createdAt.toISOString() !== preparation.preparedAt ||
        intent.expiresAt.toISOString() !== preparation.expiresAt
      )
        refuse('conflict');
      if (command.operation === 'abort') {
        assertClock(preparation, now, true);
        await transaction
          .update(authBrowserIntents)
          .set({ consumedAt: now, resultVersion: preparation.futureBrowserCursor.version, resultCredentialHash: null })
          .where(eq(authBrowserIntents.id, intent.id));
        await transaction
          .update(verificationTokens)
          .set({ token: browserPasswordReceiptHash(operationToken, browserIntentToken, preparation, 'aborted') })
          .where(and(eq(verificationTokens.identifier, identifier), eq(verificationTokens.token, preparedHash)));
        await revalidateIdentityAuthority(transaction, authority);
        assertFresh(command.issuedAt);
        assertClock(preparation, await providerDatabaseNow(transaction), true);
        return { ...metadata, operation: 'abort', outcome: 'aborted' };
      }
      assertClock(preparation, now);
      const current = await readWebPasswordCandidateInTransaction(transaction, authority, targetId);
      if (
        !current ||
        current.deleted ||
        browserPasswordStateHash(current) !== preparation.passwordStateHash ||
        current.generation !== preparation.credentialProof.generation ||
        (runtime.authority.emailVerificationEnabled && current.emailVerified === null)
      )
        refuse('conflict');
      const actor = sourceActor(source, runtime.legacySecret);
      const admitted = await readBrowserBindingInTransaction(transaction, authority, {
        bindingToken: source.bindingToken,
        actor,
      });
      if (preparation.source.state === 'anonymous') {
        if (admitted.status !== 'anonymous') refuse(admitted.status === 'admitted' ? 'conflict' : admitted.status);
      } else if (admitted.status !== 'admitted') refuse(admitted.status === 'anonymous' ? 'conflict' : admitted.status);
      else if (
        !sameBrowserPasswordSession(admitted.session, preparation.source.credentialProof, preparation.source.expiresAt)
      )
        refuse('conflict');
      const credential = actualCredential(command.payload.candidate, runtime.legacySecret);
      await assertCandidate(transaction, preparation, credential, now, false);
      if (credential.kind === 'canonical-token')
        await transaction.insert(authSession).values({
          id: preparation.credentialProof.authSessionId,
          userId: targetId,
          token: credential.token,
          expiresAt: new Date(preparation.credentialExpiresAt),
          updatedAt: now,
          revocationGeneration: preparation.credentialProof.generation,
          originalAuthenticatedAt: new Date(preparation.credentialProof.authenticatedAt),
        });
      const committed = await commitBrowserLoginInTransaction(
        transaction,
        authority,
        source.bindingToken,
        browserIntentToken,
        credential,
        actor,
      );
      if (committed.status !== 'committed' || !committed.session)
        refuse(committed.status === 'unavailable' ? 'unavailable' : 'conflict');
      if (
        committed.cursor.bindingId !== preparation.futureBrowserCursor.bindingId ||
        committed.cursor.version !== preparation.futureBrowserCursor.version ||
        committed.cursor.bindingExpiresAt.toISOString() !== preparation.futureBrowserCursor.bindingExpiresAt ||
        !sameBrowserPasswordSession(committed.session, preparation.credentialProof, preparation.credentialExpiresAt)
      )
        refuse('conflict');
      const changed = await transaction
        .update(verificationTokens)
        .set({
          token: browserPasswordReceiptHash(
            operationToken,
            browserIntentToken,
            preparation,
            'completed',
            browserPasswordCredentialHash(credential),
          ),
        })
        .where(and(eq(verificationTokens.identifier, identifier), eq(verificationTokens.token, preparedHash)))
        .returning({ token: verificationTokens.token });
      if (changed.length !== 1) refuse('conflict');
      await revalidateIdentityAuthority(transaction, authority);
      assertFresh(command.issuedAt);
      assertClock(preparation, await providerDatabaseNow(transaction));
      return completedReply(metadata, 'finalize', preparation, credential);
    });
  } catch (error) {
    return {
      ...metadata,
      operation: command.operation,
      outcome: error instanceof BrowserPasswordRefusal ? error.outcome : 'unavailable',
    };
  }
}
