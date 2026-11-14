import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authProviderReauthenticationReceipts, authProviderSecurityIntents, users } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor, ProviderSecurityProvider, WebCredentialProof } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  commitPreparedBrowserReplacementInTransaction,
  prepareBrowserReplacementInTransaction,
} from './browser-binding';
import {
  captureProviderBoundCommand,
  providerDatabaseNow,
  providerTokenHash,
  ProviderSecurityRefusal,
  type ProviderSecurityIntent,
} from './provider-security-context';
import { lockProviderSecurityMutationContext } from './provider-security-locks';
import {
  captureProviderSecurityRuntime,
  withProviderSecurityAuthority,
  type ProviderSecurityRuntime,
} from './provider-security-intents';
import {
  isUsableProviderIdentity,
  isUsableProviderPassword,
  PROVIDER_RESULT_RECOVERY_LIFETIME_MS,
} from './provider-security-policy';
import {
  providerCandidateCredentialSchema,
  providerCredentialHash,
  type ProviderCandidateCredential,
} from './provider-security-result';
import { replaceProviderCanonicalContinuation } from './provider-security-continuation';
import { recordIdentitySecurityMutation } from './security-mutation';
import { bindIdentityAuthority } from './identity-authority';
import { revalidateIdentityAuthority } from './router';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';

interface BoundInput {
  readonly actor: ProviderSecurityActor;
  readonly intentToken: string;
  readonly browserIntentToken: string;
  readonly reauthenticationToken: string;
}
type Context = Awaited<ReturnType<typeof lockProviderSecurityMutationContext>>;
function policyFailure(
  context: Context,
  runtime: ProviderSecurityRuntime,
): 'provider_unavailable' | 'ownership_conflict' | 'last_usable_method' | null {
  if (context.intent.operation === 'link') {
    if (!runtime.methods.configuredProviders.includes(context.intent.provider)) return 'provider_unavailable';
    if (context.target !== null) return 'ownership_conflict';
  } else {
    if (
      !context.target ||
      context.target.userId !== context.session.userId ||
      context.target.generation !== context.session.generation
    )
      return 'ownership_conflict';
    const alternative =
      isUsableProviderPassword(context.password, context.session.userId, context.session.generation) ||
      context.providers.some(
        (provider) =>
          (provider.provider !== context.intent.provider || provider.subject !== context.targetSubject) &&
          isUsableProviderIdentity(provider, context.session.userId, context.session.generation, runtime.methods),
      );
    if (!alternative) return 'last_usable_method';
  }
  return null;
}
async function terminalize(transaction: AuthorityTransaction, intent: ProviderSecurityIntent, now: Date) {
  await transaction
    .update(authProviderSecurityIntents)
    .set({ phase: 'terminal', consumedAt: now, candidateCredentialHash: null, recoveryExpiresAt: null })
    .where(eq(authProviderSecurityIntents.intentHash, intent.intentHash));
}

/**
 * No provider, generation or credential writes happen here. The real callback
 * must finish JWT/encode/events/redirect/error/body work into a bounded buffer
 * before passing its exact candidate to finalize.
 */
export async function prepareProviderSecurityMutation(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: BoundInput & {
    readonly flowHash: string | null;
    readonly providerProof: {
      readonly provider: ProviderSecurityProvider;
      readonly subject: string;
      readonly email: string | null;
      readonly emailVerified: boolean;
    } | null;
  },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { reauthenticationToken, flowHash } = input;
  const providerProof = input.providerProof ? Object.freeze({ ...input.providerProof }) : null;
  const preparationToken = randomBytes(32).toString('base64url');
  const proposedCanonicalToken =
    command.actor.input.kind === 'canonical-token' ? randomBytes(32).toString('base64url') : null;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const context = await lockProviderSecurityMutationContext(
      transaction,
      authority,
      command,
      reauthenticationToken,
      ['pending'],
      providerProof?.subject,
    );
    if (providerProof !== null && providerProof.provider !== context.intent.provider)
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    if (context.intent.operation === 'link') {
      if (
        !flowHash ||
        flowHash !== context.intent.flowHash ||
        !providerProof ||
        !providerProof.emailVerified ||
        !providerProof.email
      ) {
        await terminalize(transaction, context.intent, context.now);
        return { outcome: 'denied' as const, code: 'provider_not_verified' as const };
      }
    } else if (flowHash !== null || providerProof !== null)
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    const refused = policyFailure(context, runtime);
    if (refused) {
      await terminalize(transaction, context.intent, context.now);
      return { outcome: 'denied' as const, code: refused };
    }
    if (context.session.generation >= 2_147_483_647)
      throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
    const [user] = await transaction.select().from(users).where(eq(users.id, context.session.userId));
    if (!user) throw new ProviderSecurityRefusal('unauthenticated', 'invalid_proof');
    await transaction
      .update(authProviderSecurityIntents)
      .set({
        phase: 'prepared',
        preparedAt: context.now,
        preparationTokenHash: providerTokenHash(preparationToken),
        providerSubject: context.targetSubject,
        reauthenticationReceiptHash: context.proof.receiptHash,
        proposedCredentialHash:
          proposedCanonicalToken === null
            ? null
            : providerCredentialHash({ kind: 'canonical-token', credential: proposedCanonicalToken }),
      })
      .where(eq(authProviderSecurityIntents.intentHash, context.intent.intentHash));
    const credentialProof: WebCredentialProof = {
      version: 1,
      userId: context.session.userId,
      authSessionId: context.session.authSessionId,
      generation: context.session.generation + 1,
      authenticatedAt: context.session.authenticatedAt?.toISOString() ?? null,
      linkGuarded: context.session.linkGuarded,
      ...(context.session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
    };
    const now = await providerDatabaseNow(transaction);
    if (now.getTime() >= context.proof.expiresAt.getTime())
      throw new ProviderSecurityRefusal('reauthentication_required', 'expired');
    return {
      outcome: 'prepared' as const,
      preparationToken,
      credentialProof,
      credentialExpiresAt: context.session.expiresAt,
      expiresAt: new Date(Math.min(context.proof.expiresAt.getTime(), context.intent.expiresAt.getTime())),
      browserCursor: context.cursor,
      proposedCanonicalToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      },
    };
  });
}

async function validateCandidate(
  context: Context,
  candidate: ProviderCandidateCredential,
  legacySecret: string | undefined,
) {
  if (candidate.kind !== context.intent.actorCredentialKind)
    throw new ProviderSecurityRefusal('denied', 'invalid_proof');
  if (candidate.kind === 'canonical-token') {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(candidate.credential) ||
      context.intent.proposedCredentialHash !== providerCredentialHash(candidate)
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    return { kind: 'canonical-token' as const, token: candidate.credential };
  }
  if (!legacySecret) throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  const proof = await verifyLegacyNextAuthJwe(candidate.credential, legacySecret, context.now);
  if (
    !proof ||
    proof.userId !== context.session.userId ||
    (proof.authSessionId ?? proof.lineageId) !== context.session.authSessionId ||
    proof.generation !== context.session.generation + 1 ||
    proof.linkGuarded !== context.session.linkGuarded ||
    proof.requiresAccountCutoff !== context.session.requiresAccountCutoff ||
    (proof.linkGuarded ? proof.originalAuthenticatedAt?.getTime() : undefined) !==
      context.session.authenticatedAt?.getTime() ||
    proof.expiresAt.getTime() !== context.session.expiresAt.getTime()
  )
    throw new ProviderSecurityRefusal('denied', 'invalid_proof');
  return { kind: 'legacy-jwe' as const, credential: candidate.credential, secret: legacySecret };
}

/**
 * Only call after the complete final response and exact candidate are buffered.
 * The validated intent is terminal on failure; the savepoint rolls back every
 * identity/credential/cutoff/partner write. After COMMIT the caller may only
 * return the already-constructed bytes, with no later codec/hook/admission I/O.
 */
export async function finalizeProviderSecurityMutation(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: BoundInput & { readonly preparationToken: string; readonly candidate: ProviderCandidateCredential },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { reauthenticationToken, preparationToken } = input;
  const candidate = providerCandidateCredentialSchema.parse({ ...input.candidate });
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const context = await lockProviderSecurityMutationContext(transaction, authority, command, reauthenticationToken, [
      'prepared',
    ]);
    if (context.intent.preparationTokenHash !== providerTokenHash(preparationToken))
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    const credential = await validateCandidate(context, candidate, runtime.legacySecret);
    const refused = policyFailure(context, runtime);
    await terminalize(transaction, context.intent, context.now);
    if (refused) return { outcome: 'denied' as const, code: refused };
    try {
      return await transaction.transaction(async (mutation) => {
        const kind = context.intent.operation === 'link' ? ('provider-link' as const) : ('provider-unlink' as const);
        const browserPreparation = await prepareBrowserReplacementInTransaction(mutation, authority, {
          bindingToken: command.actor.input.browserBindingToken,
          intentToken: command.browserIntentToken,
          actor: { version: command.actor.input.browserVersion, credential: command.actor.credential },
          candidate: credential,
          operationId: context.intent.operationId,
          kind,
        });
        const selected = bindIdentityAuthority(mutation, authority);
        if (context.intent.operation === 'link')
          await selected.insertProvider(
            { userId: context.session.userId, provider: context.intent.provider, subject: context.targetSubject },
            context.session.generation,
          );
        else if (
          !(await selected.removeProvider(
            { userId: context.session.userId, provider: context.intent.provider, subject: context.targetSubject },
            context.session.generation,
          ))
        )
          throw new ProviderSecurityRefusal('denied', 'ownership_conflict');
        // Bind all generation/mirror work to this exact savepoint object, which
        // is also the browser preparation's and mutation receipt's identity.
        if (
          !(await selected.findProvider(context.intent.provider, context.targetSubject)) &&
          context.intent.operation === 'link'
        )
          throw new Error('PROVIDER_SECURITY_LINK_MISSING');
        const result = await recordIdentitySecurityMutation(
          mutation,
          {
            expectedProjectionId: authority.projectionId,
            expectedNormalizerVersion: authority.normalizerVersion,
            expectedWriterEpoch: authority.epoch,
            operationId: context.intent.operationId,
            userId: context.session.userId,
            expectedGeneration: context.session.generation,
            kind,
            domains: ['first-party', 'partner'],
          },
          authority,
        );
        const now = await providerDatabaseNow(mutation);
        await replaceProviderCanonicalContinuation(
          mutation,
          context.session,
          command.actor.credential,
          candidate,
          result.cutoff.generation,
          now,
        );
        const browser = await commitPreparedBrowserReplacementInTransaction(
          mutation,
          authority,
          browserPreparation,
          result.identityGenerationReceipt,
        );
        const [consumed] = await mutation
          .update(authProviderReauthenticationReceipts)
          .set({ consumedAt: now })
          .where(
            and(
              eq(authProviderReauthenticationReceipts.receiptHash, context.proof.receiptHash),
              isNull(authProviderReauthenticationReceipts.consumedAt),
            ),
          )
          .returning({ hash: authProviderReauthenticationReceipts.receiptHash });
        if (!consumed) throw new ProviderSecurityRefusal('denied', 'replayed');
        const finished = await providerDatabaseNow(mutation);
        const recoveryExpiresAt = new Date(
          Math.min(
            finished.getTime() + PROVIDER_RESULT_RECOVERY_LIFETIME_MS,
            context.intent.expiresAt.getTime(),
            context.proof.expiresAt.getTime(),
            context.session.expiresAt.getTime(),
          ),
        );
        if (recoveryExpiresAt.getTime() <= finished.getTime())
          throw new ProviderSecurityRefusal('reauthentication_required', 'expired');
        const candidateCredentialHash = providerCredentialHash(candidate);
        await mutation
          .update(authProviderSecurityIntents)
          .set({ phase: 'committed', consumedAt: finished, candidateCredentialHash, recoveryExpiresAt })
          .where(eq(authProviderSecurityIntents.intentHash, context.intent.intentHash));
        await revalidateIdentityAuthority(mutation, authority);
        if ((await providerDatabaseNow(mutation)).getTime() >= context.proof.expiresAt.getTime())
          throw new ProviderSecurityRefusal('reauthentication_required', 'expired');
        return { outcome: 'committed' as const, candidateCredentialHash, browserCursor: browser.cursor };
      });
    } catch (error) {
      if (error instanceof ProviderSecurityRefusal) return { outcome: error.outcome, code: error.code };
      return { outcome: 'unavailable' as const, code: 'authority_unavailable' as const };
    }
  });
}
