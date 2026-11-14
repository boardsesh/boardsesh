import { eq } from 'drizzle-orm';
import { users } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor, ProviderSecurityProvider, WebCredentialProof } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase } from './adapter';
import { bindIdentityAuthority } from './identity-authority';
import { lockProviderSubject } from '../current-store/foundation-context';
import {
  admitProviderActorInTransaction,
  captureProviderActor,
  providerDatabaseNow,
  ProviderSecurityRefusal,
} from './provider-security-context';
import {
  captureProviderSecurityRuntime,
  withProviderSecurityAuthority,
  type ProviderSecurityRuntime,
} from './provider-security-intents';

/** Ordinary actor renewal is ownership admission only; never link or reauthentication authority. */
export async function admitOwnedProviderForRenewal(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: {
    readonly actor: ProviderSecurityActor;
    readonly provider: ProviderSecurityProvider;
    readonly subject: string;
  },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const actor = captureProviderActor(input.actor, runtime.legacySecret);
  const { provider, subject } = input;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    await lockProviderSubject(transaction, provider, subject);
    const identity = bindIdentityAuthority(transaction, authority);
    const observed = await identity.findProvider(provider, subject);
    const { session, cursor } = await admitProviderActorInTransaction(transaction, authority, actor);
    const owner = await identity.findProvider(provider, subject, 'update');
    if (
      !observed ||
      !owner ||
      observed.userId !== owner.userId ||
      observed.generation !== owner.generation ||
      owner.userId !== session.userId ||
      owner.generation !== session.generation
    )
      throw new ProviderSecurityRefusal('denied', 'ownership_conflict');
    const [user] = await transaction.select().from(users).where(eq(users.id, session.userId));
    if (!user) throw new ProviderSecurityRefusal('unauthenticated', 'invalid_proof');
    const now = await providerDatabaseNow(transaction);
    if (now.getTime() >= session.expiresAt.getTime() || now.getTime() >= cursor.bindingExpiresAt.getTime())
      throw new ProviderSecurityRefusal('unauthenticated', 'expired');
    const credentialProof: WebCredentialProof = {
      version: 1,
      userId: session.userId,
      authSessionId: session.authSessionId,
      generation: session.generation,
      authenticatedAt: session.authenticatedAt?.toISOString() ?? null,
      linkGuarded: session.linkGuarded,
      ...(session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
    };
    return {
      outcome: 'owned' as const,
      credentialProof,
      credentialExpiresAt: session.expiresAt,
      browserCursor: cursor,
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
