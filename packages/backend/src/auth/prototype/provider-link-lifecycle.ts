import { createHash, randomUUID } from 'node:crypto';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  freshSessionMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority, type PrototypeAuthority, type PrototypeDatabase } from './authority';
import {
  createPrototypeCredentialContinuation,
  prototypeCredentialFailureWithoutCookies,
  readPrototypeCredentialSource,
  readPrototypeCredentialSourceForIdentity,
  type PrototypeCredentialContext,
  type PrototypeCredentialSource,
} from './credential-continuation';
import { PROTOTYPE_CONFIGURATION } from './configuration';
import { PROTOTYPE_ISSUER } from './oauth-options';
import { createPrototypePolicyResponseObserver } from './policy-response';
import { PrototypeResponseRollback, rejectPrototypeServerFailure } from './transaction-response';

const providers = ['google', 'apple', 'facebook'] as const;
type ProviderName = (typeof providers)[number];
type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];
export const PROTOTYPE_PROVIDER_LINK_PATHS = {
  link: '/prototype-provider-link/link',
  unlink: '/prototype-provider-link/unlink',
} as const;
export const PROTOTYPE_PROVIDER_LINK_CALLBACK = 'https://www.boardsesh.test/settings?providerLink=complete';
export const PROTOTYPE_EXPLICIT_PROVIDER_LINK_POLICY = {
  enabled: true,
  disableImplicitLinking: true,
  // Explicit verified Graph subject ownership, never email ownership or auto-link.
  trustedProviders: ['facebook'],
  allowDifferentEmails: true,
  allowUnlinkingAll: false,
  updateUserInfoOnLink: false,
} satisfies NonNullable<NonNullable<BetterAuthOptions['account']>['accountLinking']>;
const ERROR_CALLBACK = 'https://www.boardsesh.test/settings?providerLink=failed';
const INTENT_PREFIX = 'prototype-provider-link-intent:';
const intentSchema = z.object({
  kind: z.literal('provider-link'),
  provider: z.enum(providers),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().positive(),
});

interface ProviderLinkOptions {
  readonly authority: BetterAuthOptions;
  readonly afterMutation?: (kind: 'provider-link' | 'provider-unlink', userId: string) => Promise<void>;
}

function intentIdentifier(state: string): string {
  return `${INTENT_PREFIX}${createHash('sha256').update(state).digest('hex')}`;
}

function providerName(candidate: string | undefined): candidate is ProviderName {
  return providers.some((provider) => provider === candidate);
}

function linkedAccountError(): APIError {
  return new APIError('CONFLICT', {
    code: 'PROVIDER_OWNERSHIP_CONFLICT',
    message: 'This provider identity cannot be linked.',
  });
}

function parseIntent(serialized: string) {
  try {
    return intentSchema.safeParse(JSON.parse(serialized));
  } catch {
    return null;
  }
}

function guardedProviders(
  configured: BetterAuthOptions['socialProviders'],
  verifiedSubject: (provider: ProviderName, subject: string) => Promise<void>,
): BetterAuthOptions['socialProviders'] {
  const google = configured?.google;
  const apple = configured?.apple;
  const facebook = configured?.facebook;
  if ([google, apple, facebook].some((provider) => typeof provider === 'function')) {
    throw new Error('The disposable provider-link proof requires fixed provider configurations.');
  }
  return {
    ...(google && typeof google === 'object'
      ? {
          google: {
            ...google,
            async mapProfileToUser(profile) {
              await verifiedSubject('google', profile.sub);
              return (await google.mapProfileToUser?.(profile)) ?? {};
            },
          },
        }
      : {}),
    ...(apple && typeof apple === 'object'
      ? {
          apple: {
            ...apple,
            async mapProfileToUser(profile) {
              await verifiedSubject('apple', profile.sub);
              return (await apple.mapProfileToUser?.(profile)) ?? {};
            },
          },
        }
      : {}),
    ...(facebook && typeof facebook === 'object'
      ? {
          facebook: {
            ...facebook,
            async mapProfileToUser(profile) {
              await verifiedSubject('facebook', 'sub' in profile ? profile.sub : profile.id);
              return (await facebook.mapProfileToUser?.(profile)) ?? {};
            },
          },
        }
      : {}),
  };
}

function configuredIdentifier(candidate: unknown): boolean {
  return typeof candidate === 'string' && candidate.length > 0 && candidate === candidate.trim();
}

function configuredIdentifiers(candidate: unknown): boolean {
  return Array.isArray(candidate)
    ? candidate.length > 0 && candidate.every(configuredIdentifier)
    : configuredIdentifier(candidate);
}

async function usableAccount(
  transaction: PrototypeTransaction,
  account: typeof schema.account.$inferSelect,
  configured: BetterAuthOptions['socialProviders'],
): Promise<boolean> {
  if (account.providerId === 'credential') {
    const passwordHash = account.password;
    if (
      account.accountId !== account.userId ||
      !passwordHash ||
      !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)
    )
      return false;
    const cost = Number(passwordHash.slice(4, 6));
    if (cost < 4 || cost > 31) return false;
    const credentials = await transaction
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, account.userId), eq(schema.account.providerId, 'credential')))
      .limit(2);
    return credentials.length === 1 && credentials[0].id === account.id;
  }
  if (!providerName(account.providerId) || !account.accountId) return false;
  const provider = configured?.[account.providerId];
  if (
    !provider ||
    typeof provider !== 'object' ||
    provider.enabled === false ||
    !configuredIdentifiers(provider.clientId) ||
    !configuredIdentifier(provider.clientSecret) ||
    ('audience' in provider && provider.audience !== undefined && !configuredIdentifiers(provider.audience))
  )
    return false;
  const owners = await transaction
    .select({ id: schema.account.id, userId: schema.account.userId })
    .from(schema.account)
    .where(and(eq(schema.account.providerId, account.providerId), eq(schema.account.accountId, account.accountId)))
    .limit(2);
  return owners.length === 1 && owners[0].id === account.id && owners[0].userId === account.userId;
}

async function assertIdentityUnchanged(transaction: PrototypeTransaction, before: typeof schema.user.$inferSelect) {
  const [current] = await transaction.select().from(schema.user).where(eq(schema.user.id, before.id));
  if (
    !current ||
    current.email !== before.email ||
    current.emailVerified !== before.emailVerified ||
    current.legacyEmailVerifiedAt?.getTime() !== before.legacyEmailVerifiedAt?.getTime() ||
    current.name !== before.name ||
    current.image !== before.image
  ) {
    throw new APIError('INTERNAL_SERVER_ERROR', { code: 'PROVIDER_LINK_IDENTITY_CHANGED' });
  }
}

async function consumeCallbackIntent(
  transaction: PrototypeTransaction,
  url: URL,
  provider: ProviderName,
  headers: Headers,
  options: ProviderLinkOptions,
) {
  const gate = createPrototypeAuthority(transaction, {
    ...options.authority,
    session: {
      ...options.authority.session,
      freshAge: PROTOTYPE_CONFIGURATION.session.freshAge,
      cookieCache: { enabled: false },
    },
    advanced: { ...options.authority.advanced, disableOriginCheck: false, disableCSRFCheck: false },
  });
  const identity = await gate.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
  const source = await readPrototypeCredentialSourceForIdentity(transaction, identity);
  const state = url.searchParams.get('state');
  if (!state || url.searchParams.getAll('state').length !== 1)
    throw new APIError('BAD_REQUEST', { code: 'INVALID_PROVIDER_LINK_INTENT' });
  const records = await transaction
    .select()
    .from(schema.verification)
    .where(eq(schema.verification.identifier, intentIdentifier(state)))
    .limit(2)
    .for('update');
  const receipt = records.length === 1 ? records[0] : undefined;
  const parsed = receipt ? parseIntent(receipt.value) : null;
  if (
    !receipt ||
    !parsed?.success ||
    parsed.data.provider !== provider ||
    parsed.data.userId !== source.userId ||
    parsed.data.sessionId !== source.id ||
    parsed.data.generation !== source.revocationGeneration ||
    parsed.data.expiresAt !== receipt.expiresAt.getTime() ||
    parsed.data.expiresAt <= Date.now()
  ) {
    throw new APIError('BAD_REQUEST', { code: 'INVALID_PROVIDER_LINK_INTENT' });
  }
  const consumed = await transaction
    .delete(schema.verification)
    .where(eq(schema.verification.id, receipt.id))
    .returning({ id: schema.verification.id });
  if (consumed.length !== 1) throw new APIError('BAD_REQUEST', { code: 'INVALID_PROVIDER_LINK_INTENT' });
  return parsed.data;
}

/**
 * Disposable explicit link/unlink proof. The real provider verifier and Better
 * Auth account APIs own every write. No production router mounts this adapter.
 * Current-device continuation here is an agent decision, not a user policy answer.
 */
export function createPrototypeProviderLinkLifecycle(database: PrototypeDatabase, options: ProviderLinkOptions) {
  return {
    async handler(request: Request): Promise<Response> {
      const method = request.method;
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      const body = ['GET', 'HEAD'].includes(method) ? undefined : await request.clone().text();
      const captured = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
      const issuerPath = new URL(PROTOTYPE_ISSUER).pathname;
      const isLink = url.pathname === `${issuerPath}${PROTOTYPE_PROVIDER_LINK_PATHS.link}`;
      const isUnlink = url.pathname === `${issuerPath}${PROTOTYPE_PROVIDER_LINK_PATHS.unlink}`;
      const callbackProvider = url.pathname.startsWith(`${issuerPath}/callback/`)
        ? url.pathname.slice(`${issuerPath}/callback/`.length)
        : undefined;
      const isCallback = providerName(callbackProvider);
      if (!isLink && !isUnlink && !isCallback) return new Response(null, { status: 404 });
      if (isCallback && !['GET', 'POST'].includes(method)) return new Response(null, { status: 405 });

      try {
        return await database.transaction(async (outerTransaction) => {
          await outerTransaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
          const callbackBinding =
            isCallback && method === 'GET'
              ? await consumeCallbackIntent(outerTransaction, url, callbackProvider, headers, options)
              : undefined;
          const execute = async (transaction: PrototypeTransaction): Promise<Response> => {
            let authority: PrototypeAuthority;
            let source: PrototypeCredentialSource | undefined;
            let originalUser: typeof schema.user.$inferSelect | undefined;
            let selectedProvider: ProviderName | undefined;
            let verified: { provider: ProviderName; subject: string } | undefined;
            let mutationFinished = false;
            const continuation = createPrototypeCredentialContinuation(
              transaction,
              options.authority.databaseHooks?.session?.create?.before,
            );

            async function selectActor(context: PrototypeCredentialContext) {
              source = await readPrototypeCredentialSource(transaction, context);
              [originalUser] = await transaction.select().from(schema.user).where(eq(schema.user.id, source.userId));
              if (!originalUser) throw new APIError('UNAUTHORIZED');
              return source;
            }

            async function checkVerifiedSubject(provider: ProviderName, subject: string) {
              if (!source || selectedProvider !== provider || typeof subject !== 'string' || subject.length === 0) {
                throw new APIError('UNAUTHORIZED');
              }
              // Provider network work can outlast the remaining freshness window.
              // Recheck the proven canonical source immediately before account writes.
              const actor = await readPrototypeCredentialSourceForIdentity(transaction, {
                user: { id: source.userId },
                session: { id: source.id, token: source.token },
              });
              const owners = await transaction
                .select()
                .from(schema.account)
                .where(and(eq(schema.account.providerId, provider), eq(schema.account.accountId, subject)));
              if (owners.length > 1 || owners.some((account) => account.userId !== actor.userId))
                throw linkedAccountError();
              verified = { provider, subject };
            }

            async function finish(context: PrototypeCredentialContext, kind: 'provider-link' | 'provider-unlink') {
              if (!source || !originalUser) throw new APIError('UNAUTHORIZED');
              if (kind === 'provider-link') {
                if (!verified) throw new APIError('INTERNAL_SERVER_ERROR');
                const links = await transaction
                  .select()
                  .from(schema.account)
                  .where(
                    and(
                      eq(schema.account.providerId, verified.provider),
                      eq(schema.account.accountId, verified.subject),
                    ),
                  );
                if (links.length !== 1 || links[0].userId !== source.userId) throw linkedAccountError();
              }
              await assertIdentityUnchanged(transaction, originalUser);
              await continuation.replace(
                context,
                source,
                () => options.afterMutation?.(kind, source!.userId) ?? Promise.resolve(),
              );
              mutationFinished = true;
            }

            const plugin: BetterAuthPlugin = {
              id: 'boardsesh-prototype-provider-link-lifecycle',
              endpoints: {
                prototypeProviderLink: createAuthEndpoint(
                  PROTOTYPE_PROVIDER_LINK_PATHS.link,
                  {
                    method: 'POST',
                    body: z
                      .object({
                        provider: z.enum(providers),
                        idToken: z
                          .object({ token: z.string().min(1), nonce: z.string().optional() })
                          .strict()
                          .optional(),
                      })
                      .strict(),
                    use: [freshSessionMiddleware],
                  },
                  async (context) => {
                    const actor = await selectActor(context);
                    selectedProvider = context.body.provider;
                    const linked = await authority.api.linkSocialAccount({
                      headers: new Headers(context.headers),
                      body: {
                        provider: selectedProvider,
                        idToken: context.body.idToken,
                        callbackURL: PROTOTYPE_PROVIDER_LINK_CALLBACK,
                        errorCallbackURL: ERROR_CALLBACK,
                        disableRedirect: true,
                      },
                      asResponse: true,
                    });
                    rejectPrototypeServerFailure(linked);
                    if (!linked.ok) return linked;
                    if (context.body.idToken) {
                      await finish(context, 'provider-link');
                      return context.json({ status: true, requiresSignIn: false });
                    }
                    const result: unknown = await linked.clone().json();
                    if (
                      typeof result !== 'object' ||
                      result === null ||
                      !('url' in result) ||
                      typeof result.url !== 'string'
                    )
                      throw new APIError('INTERNAL_SERVER_ERROR');
                    const state = new URL(result.url).searchParams.get('state');
                    if (!state) throw new APIError('INTERNAL_SERVER_ERROR');
                    const expiresAt = Math.min(
                      actor.expiresAt.getTime(),
                      actor.originalAuthenticatedAt.getTime() + PROTOTYPE_CONFIGURATION.session.freshAge * 1000,
                    );
                    if (expiresAt <= Date.now()) throw new APIError('FORBIDDEN', { code: 'SESSION_NOT_FRESH' });
                    await transaction.insert(schema.verification).values({
                      id: randomUUID(),
                      identifier: intentIdentifier(state),
                      value: JSON.stringify({
                        kind: 'provider-link',
                        provider: selectedProvider,
                        userId: actor.userId,
                        sessionId: actor.id,
                        generation: actor.revocationGeneration,
                        expiresAt,
                      }),
                      expiresAt: new Date(expiresAt),
                    });
                    return linked;
                  },
                ),
                prototypeProviderUnlink: createAuthEndpoint(
                  PROTOTYPE_PROVIDER_LINK_PATHS.unlink,
                  {
                    method: 'POST',
                    body: z.object({ accountId: z.string().min(1) }).strict(),
                    use: [freshSessionMiddleware],
                  },
                  async (context) => {
                    const actor = await selectActor(context);
                    const accounts = await transaction
                      .select()
                      .from(schema.account)
                      .where(eq(schema.account.userId, actor.userId));
                    const selected = accounts.find((account) => account.id === context.body.accountId);
                    if (!selected || !providerName(selected.providerId))
                      throw new APIError('BAD_REQUEST', { code: 'ACCOUNT_NOT_FOUND' });
                    let remainingUsableMethod = false;
                    for (const account of accounts) {
                      if (
                        account.id !== selected.id &&
                        (await usableAccount(transaction, account, options.authority.socialProviders))
                      ) {
                        remainingUsableMethod = true;
                        break;
                      }
                    }
                    if (!remainingUsableMethod) {
                      throw new APIError('BAD_REQUEST', { code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
                    }
                    const unlinked = await authority.api.unlinkAccount({
                      headers: context.headers,
                      body: { accountId: selected.id },
                      asResponse: true,
                    });
                    rejectPrototypeServerFailure(unlinked);
                    if (!unlinked.ok) return unlinked;
                    const remaining = await transaction
                      .select()
                      .from(schema.account)
                      .where(eq(schema.account.id, selected.id));
                    if (remaining.length !== 0) throw new APIError('INTERNAL_SERVER_ERROR');
                    await finish(context, 'provider-unlink');
                    return context.json({ status: true, requiresSignIn: false });
                  },
                ),
              },
              hooks: {
                before: [
                  {
                    matcher: (context) =>
                      isCallback &&
                      context.method === 'GET' &&
                      context.path === '/callback/:id' &&
                      context.params?.id === callbackProvider,
                    handler: createAuthMiddleware(async (context) => {
                      const current = await getSessionFromCtx(context, { disableCookieCache: true });
                      if (!current) throw new APIError('UNAUTHORIZED');
                      const actor = await selectActor(context);
                      if (
                        !callbackBinding ||
                        callbackBinding.provider !== callbackProvider ||
                        callbackBinding.userId !== actor.userId ||
                        callbackBinding.sessionId !== actor.id ||
                        callbackBinding.generation !== actor.revocationGeneration
                      ) {
                        throw new APIError('BAD_REQUEST', { code: 'INVALID_PROVIDER_LINK_INTENT' });
                      }
                      selectedProvider = callbackBinding.provider;
                    }),
                  },
                ],
                after: [
                  {
                    matcher: (context) =>
                      isCallback &&
                      context.method === 'GET' &&
                      context.path === '/callback/:id' &&
                      context.params?.id === callbackProvider,
                    handler: createAuthMiddleware(async (context) => {
                      if (context.context.responseHeaders?.get('location') !== PROTOTYPE_PROVIDER_LINK_CALLBACK) return;
                      if (!callbackBinding || !source || !verified) throw new APIError('INTERNAL_SERVER_ERROR');
                      await finish(context, 'provider-link');
                    }),
                  },
                ],
              },
            };

            const providerOptions = guardedProviders(options.authority.socialProviders, checkVerifiedSubject);
            const policyObserver = createPrototypePolicyResponseObserver();
            authority = createPrototypeAuthority(transaction, {
              ...options.authority,
              socialProviders: providerOptions,
              account: {
                ...options.authority.account,
                skipStateCookieCheck: false,
                storeStateStrategy: 'database',
                accountLinking: PROTOTYPE_EXPLICIT_PROVIDER_LINK_POLICY,
              },
              session: {
                ...options.authority.session,
                freshAge: PROTOTYPE_CONFIGURATION.session.freshAge,
                cookieCache: { enabled: false },
              },
              advanced: { ...options.authority.advanced, disableOriginCheck: false, disableCSRFCheck: false },
              databaseHooks: {
                ...options.authority.databaseHooks,
                session: {
                  ...options.authority.databaseHooks?.session,
                  create: {
                    ...options.authority.databaseHooks?.session?.create,
                    before: continuation.beforeSessionCreate,
                  },
                },
              },
              plugins: [plugin, ...(options.authority.plugins ?? []), policyObserver.plugin],
            });
            const response = await authority.handler(captured);
            const policyFailure = policyObserver.failure();
            if (policyFailure) throw new PrototypeResponseRollback(policyFailure);
            rejectPrototypeServerFailure(response);
            if (isCallback && method === 'POST') {
              const location = response.headers.get('location');
              if (
                response.status !== 302 ||
                !location ||
                new URL(location).origin !== url.origin ||
                new URL(location).pathname !== url.pathname
              )
                throw new PrototypeResponseRollback(response);
              return response;
            }
            if (isCallback) {
              if (
                !mutationFinished ||
                response.status !== 302 ||
                response.headers.get('location') !== PROTOTYPE_PROVIDER_LINK_CALLBACK
              )
                throw new PrototypeResponseRollback(response);
            } else if (!response.ok) throw new PrototypeResponseRollback(response);
            return response;
          };
          if (callbackBinding) {
            // The validated intent is terminal even when the provider cancels or
            // the inner credential mutation fails. Preserve that consumption,
            // while a savepoint rolls back every credential and cookie change.
            try {
              return await outerTransaction.transaction(execute);
            } catch (error) {
              if (error instanceof PrototypeResponseRollback)
                return prototypeCredentialFailureWithoutCookies(error.response);
              throw error;
            }
          }
          return execute(outerTransaction);
        });
      } catch (error) {
        if (error instanceof PrototypeResponseRollback) return prototypeCredentialFailureWithoutCookies(error.response);
        if (error instanceof APIError)
          return Response.json(error.body ?? { code: 'PROVIDER_LINK_REJECTED' }, { status: error.statusCode });
        throw error;
      }
    },
  };
}
