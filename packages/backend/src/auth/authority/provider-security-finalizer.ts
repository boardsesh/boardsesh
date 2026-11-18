import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authProviderReauthenticationReceipts, authProviderSecurityIntents, users } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor, ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  captureProviderBoundCommand,
  providerDatabaseNow,
  providerTokenHash,
  ProviderSecurityRefusal,
  requireCanonicalProviderActor,
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
import { continueProviderSessionInPlace } from './provider-security-continuation';
import { recordIdentitySecurityMutation } from './security-mutation';
import { bindIdentityAuthority } from './identity-authority';
import { revalidateIdentityAuthority } from './router';

interface BoundInput {
  readonly actor: ProviderSecurityActor;
  readonly intentToken: string;
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
 * No provider, generation or credential writes happen here. Nothing is minted
 * either: the requesting session keeps its token through finalize.
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
        proposedCredentialHash: null,
      })
      .where(eq(authProviderSecurityIntents.intentHash, context.intent.intentHash));
    const now = await providerDatabaseNow(transaction);
    if (now.getTime() >= context.proof.expiresAt.getTime())
      throw new ProviderSecurityRefusal('reauthentication_required', 'expired');
    return {
      outcome: 'prepared' as const,
      preparationToken,
      expiresAt: new Date(Math.min(context.proof.expiresAt.getTime(), context.intent.expiresAt.getTime())),
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

/**
 * The validated intent is terminal on failure; the savepoint rolls back every
 * identity/credential/cutoff/partner write. The requesting session keeps its
 * id, token, sign-in time and expiry and moves to the account's new
 * generation; every other first-party credential of the account ends.
 */
export async function finalizeProviderSecurityMutation(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: BoundInput & { readonly preparationToken: string },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { reauthenticationToken, preparationToken } = input;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const context = await lockProviderSecurityMutationContext(transaction, authority, command, reauthenticationToken, [
      'prepared',
    ]);
    if (context.intent.preparationTokenHash !== providerTokenHash(preparationToken))
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    // Intent creation already refuses any other actor.
    const { token } = requireCanonicalProviderActor(command.actor);
    const refused = policyFailure(context, runtime);
    await terminalize(transaction, context.intent, context.now);
    if (refused) return { outcome: 'denied' as const, code: refused };
    try {
      return await transaction.transaction(async (mutation) => {
        const kind = context.intent.operation === 'link' ? ('provider-link' as const) : ('provider-unlink' as const);
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
        // is also the mutation receipt's identity.
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
        const continued = await continueProviderSessionInPlace(
          mutation,
          context.session,
          token,
          result.identityGenerationReceipt,
          { operationId: context.intent.operationId, kind },
          now,
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
        // The credential that continues is the presented one: its hash fills the
        // NOT NULL column a committed intent requires.
        await mutation
          .update(authProviderSecurityIntents)
          .set({
            phase: 'committed',
            consumedAt: finished,
            candidateCredentialHash: context.intent.actorCredentialHash,
            recoveryExpiresAt,
          })
          .where(eq(authProviderSecurityIntents.intentHash, context.intent.intentHash));
        await revalidateIdentityAuthority(mutation, authority);
        if ((await providerDatabaseNow(mutation)).getTime() >= context.proof.expiresAt.getTime())
          throw new ProviderSecurityRefusal('reauthentication_required', 'expired');
        return { outcome: 'committed' as const, generation: continued.generation };
      });
    } catch (error) {
      if (error instanceof ProviderSecurityRefusal) return { outcome: error.outcome, code: error.code };
      return { outcome: 'unavailable' as const, code: 'authority_unavailable' as const };
    }
  });
}
