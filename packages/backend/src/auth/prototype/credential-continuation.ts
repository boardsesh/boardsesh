import type { BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, like } from 'drizzle-orm';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';
import { revokePrototypeUser } from './legacy-bridge';
import { prototypeSessionPassesRevocation } from './session-revocation';
import { PROTOTYPE_CONFIGURATION } from './configuration';

type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];
export type PrototypeCredentialContext = Parameters<typeof setSessionCookie>[0];
type SessionCreateBefore = NonNullable<
  NonNullable<NonNullable<NonNullable<BetterAuthOptions['databaseHooks']>['session']>['create']>['before']
>;
export type PrototypeCredentialSource = typeof schema.session.$inferSelect & { originalAuthenticatedAt: Date };

export function prototypeCredentialFailureWithoutCookies(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The canonical source must be proven live, current and recently authenticated.
 * Authentication age and revocation eligibility remain distinct authority facts.
 * Call within the shared lifecycle transaction and advisory fence.
 */
export async function readPrototypeCredentialSource(
  transaction: PrototypeTransaction,
  context: PrototypeCredentialContext,
): Promise<PrototypeCredentialSource> {
  return readPrototypeCredentialSourceForIdentity(transaction, context.context.session);
}

/** Identity must come from the authority's verified getSession result. */
export async function readPrototypeCredentialSourceForIdentity(
  transaction: PrototypeTransaction,
  session: { user: { id: string }; session: { id: string; token: string } } | null | undefined,
): Promise<PrototypeCredentialSource> {
  if (!session) throw new APIError('UNAUTHORIZED');
  const [source] = await transaction
    .select()
    .from(schema.session)
    .where(
      and(
        eq(schema.session.id, session.session.id),
        eq(schema.session.userId, session.user.id),
        eq(schema.session.token, session.session.token),
      ),
    );
  const [cutoff] = await transaction
    .select()
    .from(schema.prototypeUserCutoff)
    .where(eq(schema.prototypeUserCutoff.userId, session.user.id));
  const now = Date.now();
  if (!source || source.expiresAt.getTime() <= now || !prototypeSessionPassesRevocation(source, cutoff)) {
    throw new APIError('UNAUTHORIZED');
  }
  const originalAuthenticatedAt = source.originalAuthenticatedAt ?? (source.legacyLineageId ? null : source.createdAt);
  if (
    !originalAuthenticatedAt ||
    originalAuthenticatedAt.getTime() !== source.createdAt.getTime() ||
    originalAuthenticatedAt.getTime() > now ||
    now - originalAuthenticatedAt.getTime() >= PROTOTYPE_CONFIGURATION.session.freshAge * 1000
  ) {
    throw new APIError('FORBIDDEN', {
      code: 'SESSION_NOT_FRESH',
      message: 'A proven recent authentication is required.',
    });
  }
  return { ...source, originalAuthenticatedAt };
}

/**
 * Reuse only within the existing whole-request transaction. A caller completes
 * its real authority mutation before invoking replace(); no credential verifier
 * or writer lives in this continuation helper.
 */
export function createPrototypeCredentialContinuation(
  transaction: PrototypeTransaction,
  originalSessionCreateBefore?: SessionCreateBefore,
) {
  let continuationSource: PrototypeCredentialSource | undefined;
  const beforeSessionCreate: SessionCreateBefore = async (candidate, context) => {
    const previous = await originalSessionCreateBefore?.(candidate, context);
    if (previous === false) return false;
    if (!continuationSource) throw new APIError('INTERNAL_SERVER_ERROR');
    return {
      data: {
        ...candidate,
        ...(typeof previous === 'object' && previous !== null ? previous.data : {}),
        userId: continuationSource.userId,
        createdAt: continuationSource.createdAt,
        updatedAt: new Date(),
        expiresAt: continuationSource.expiresAt,
        originalAuthenticatedAt: continuationSource.originalAuthenticatedAt,
        legacyLineageId: null,
      },
    };
  };

  async function replace(
    context: PrototypeCredentialContext,
    source: PrototypeCredentialSource,
    beforeCookie?: () => Promise<void>,
  ): Promise<typeof schema.session.$inferSelect> {
    const session = context.context.session;
    if (
      !session ||
      session.user.id !== source.userId ||
      session.session.id !== source.id ||
      session.session.token !== source.token
    )
      throw new APIError('UNAUTHORIZED');
    const generation = await revokePrototypeUser(transaction, source.userId);
    await transaction
      .delete(schema.verification)
      .where(
        and(like(schema.verification.identifier, 'reset-password:%'), eq(schema.verification.value, source.userId)),
      );
    continuationSource = source;
    const replacement = await context.context.internalAdapter.createSession(source.userId);
    const [persisted] = replacement
      ? await transaction.select().from(schema.session).where(eq(schema.session.id, replacement.id))
      : [];
    if (
      !replacement ||
      !persisted ||
      replacement.userId !== source.userId ||
      persisted.userId !== source.userId ||
      replacement.id === source.id ||
      replacement.token === source.token ||
      persisted.token !== replacement.token ||
      persisted.revocationGeneration !== generation ||
      persisted.createdAt.getTime() !== source.createdAt.getTime() ||
      persisted.originalAuthenticatedAt?.getTime() !== source.originalAuthenticatedAt.getTime() ||
      persisted.expiresAt.getTime() !== source.expiresAt.getTime() ||
      persisted.legacyLineageId !== null
    ) {
      throw new APIError('INTERNAL_SERVER_ERROR');
    }
    await beforeCookie?.();
    await setSessionCookie(context, { session: persisted, user: session.user });
    context.setHeader('cache-control', 'no-store');
    return persisted;
  }

  return { beforeSessionCreate, replace };
}
