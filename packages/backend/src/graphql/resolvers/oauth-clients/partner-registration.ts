import { GraphQLError } from 'graphql';
import {
  confirmPartnerDeveloperEmail,
  hasVerifiedPartnerDeveloperEmail,
  readPartnerDeveloperEmailStatus,
  requestPartnerDeveloperEmail,
} from '../../../auth/partner/developer-email';
import { sendPartnerDeveloperVerificationEmail } from '../../../email/partner-developer-email';
import { PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS } from '@boardsesh/auth-protocol/auth-time';
import {
  PARTNER_CONSOLE_ALLOWLIST_UNAVAILABLE,
  PARTNER_CONSOLE_RECENT_SIGN_IN_REQUIRED,
} from '@boardsesh/auth-protocol/partner-oauth';
import type {
  ConnectionContext,
  CreateOAuthClientInput,
  OAuthClient,
  OAuthClientCredentials,
  UpdateOAuthClientInput,
} from '@boardsesh/shared-schema';
import {
  __resetPartnerDeveloperAccessForTests,
  checkPartnerDeveloperAccess,
} from '../../../auth/partner/developer-access';
import { loadPartnerAuthority } from '../../../auth/partner/load-authority';
import { readPartnerOAuthMode, type PartnerOAuthMode } from '../../../auth/partner/mode';
import {
  PartnerRegistrationError,
  type PartnerAppCredentials,
  type PartnerAppRecord,
  type PartnerRegistrationRefusal,
} from '../../../auth/partner/registration-rules';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import { RateLimitError } from '../../../utils/rate-limiter';
import { checkRateLimitRedis } from '../../../utils/redis-rate-limiter';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';

/**
 * The developer console's GraphQL operations. This is the only GraphQL module
 * that reaches into `auth/partner/`, and it loads nothing there until the mode
 * allows it: with PARTNER_OAUTH_MODE off every operation answers NOT_FOUND
 * before authentication, rate limits, the database or Better Auth.
 */

type PartnerRuntime = NonNullable<Awaited<ReturnType<typeof loadPartnerAuthority>>>;
type PartnerRegistrationService = PartnerRuntime['registration'];
type RegistrationDatabase = Parameters<PartnerRegistrationService['listApps']>[0];

const WINDOW_MS = 60_000;
/** Writes: create, edit, rotate, delete. Ten a minute is far above a person at a form. */
const WRITES_PER_DEVELOPER = 10;
const WRITES_PER_ADDRESS = 30;
const READS_PER_DEVELOPER = 60;
const READS_PER_ADDRESS = 120;
const RETRY_AFTER_SECONDS = 60;

let deploymentMode: PartnerOAuthMode | undefined;

/** Read once, from the environment. No request can choose it. */
function registrationMode(): PartnerOAuthMode {
  deploymentMode ??= readPartnerOAuthMode();
  return deploymentMode;
}

/** Forgets the mode and the cached `developer-console` answers, as a fresh deploy would. */
export function __resetPartnerRegistrationDeploymentForTests(): void {
  deploymentMode = undefined;
  __resetPartnerDeveloperAccessForTests();
}

function rateLimited(error: RateLimitError, operation: string): GraphQLError {
  return new GraphQLError(error.message, {
    extensions: { code: 'RATE_LIMITED', operation, retryAfterSeconds: error.retryAfterSeconds },
  });
}

type DeveloperLimitPurpose = 'app' | 'email';

function limitOperation(kind: 'read' | 'write', purpose: DeveloperLimitPurpose = 'app'): string {
  if (purpose === 'email') return kind === 'write' ? 'oauthClientEmailWrite' : 'oauthClientEmailRead';
  return kind === 'write' ? 'oauthClientWrite' : 'oauthClientRead';
}

/** Charged only once the caller is a signed-in account, and only that account can spend it. */
async function chargeDeveloperLimit(
  ctx: ConnectionContext,
  kind: 'read' | 'write',
  purpose: DeveloperLimitPurpose = 'app',
): Promise<void> {
  await applyRateLimit(
    ctx,
    kind === 'write' ? WRITES_PER_DEVELOPER : READS_PER_DEVELOPER,
    limitOperation(kind, purpose),
  );
}

/**
 * The `developer-console` flag, asked before any transaction or Better Auth
 * work (`auth/partner/developer-access.ts`). PostHog saying no is
 * `NOT_ALLOWLISTED`; PostHog not answering is not a no, so it gets its own
 * reason and the console offers a retry.
 */
async function requireInvitedDeveloper(developerId: string): Promise<void> {
  const { decision } = await checkPartnerDeveloperAccess(developerId);
  if (decision === 'allowed') return;
  if (decision === 'refused') {
    throw new GraphQLError('Developer apps are invite-only for now.', {
      extensions: { code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' },
    });
  }
  throw new GraphQLError("Developer apps couldn't check your invite. Try again in a minute.", {
    extensions: {
      code: 'SERVICE_UNAVAILABLE',
      reason: PARTNER_CONSOLE_ALLOWLIST_UNAVAILABLE,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    },
  });
}

/**
 * Charged only for an allowlisted developer, so throwaway accounts behind the
 * same address cannot fill it. Keyed by `trustedClientIp`, which believes
 * `cf-connecting-ip` only from a verified Cloudflare edge and groups an IPv6
 * client by its /64, so a direct-origin caller cannot choose the bucket.
 */
async function chargeAddressLimit(
  ctx: ConnectionContext,
  kind: 'read' | 'write',
  purpose: DeveloperLimitPurpose = 'app',
): Promise<void> {
  const operation = limitOperation(kind, purpose);
  if (!ctx.trustedClientIp || process.env.NODE_ENV === 'development') return;
  try {
    await checkRateLimitRedis(
      `oauth-client-ip:${ctx.trustedClientIp}`,
      operation,
      kind === 'write' ? WRITES_PER_ADDRESS : READS_PER_ADDRESS,
      WINDOW_MS,
    );
  } catch (error) {
    if (error instanceof RateLimitError) throw rateLimited(error, operation);
    throw error;
  }
}

const REFUSAL_CODES: Record<PartnerRegistrationRefusal, string> = {
  invalid_input: 'BAD_USER_INPUT',
  app_limit_reached: 'BAD_USER_INPUT',
  no_secret: 'BAD_USER_INPUT',
  // The console shows the message in the form: registration waits for the terms.
  terms_unpublished: 'BAD_USER_INPUT',
  email_not_verified: 'FORBIDDEN',
  suspended: 'FORBIDDEN',
  // Not UNAUTHENTICATED: the session is valid, and a 401 would sign the app out.
  recent_sign_in_required: 'FORBIDDEN',
  not_found: 'NOT_FOUND',
  busy: 'SERVICE_UNAVAILABLE',
};

function refusalError(error: PartnerRegistrationError): GraphQLError {
  if (error.reason === 'recent_sign_in_required') {
    return new GraphQLError(error.message, {
      extensions: {
        code: REFUSAL_CODES[error.reason],
        reason: PARTNER_CONSOLE_RECENT_SIGN_IN_REQUIRED,
        maxAgeSeconds: PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS,
      },
    });
  }
  return new GraphQLError(error.message, {
    extensions: { code: REFUSAL_CODES[error.reason], reason: error.reason.toUpperCase() },
  });
}

/**
 * Every operation's way in. The order is the contract: the mode first, so an
 * off deployment does nothing at all; then the account and its own limit; then
 * the `developer-console` flag; then the address limit, which only invited
 * developers spend. `allowlist` requires the developer-console invite. `open` instead requires
 * independent ownership proof of the exact current developer email. The legacy
 * `emailVerified` stamp never grants access.
 */
export async function withRegistration<Result>(
  ctx: ConnectionContext,
  kind: 'read' | 'write',
  work: (
    registration: PartnerRegistrationService,
    developerId: string,
    database: RegistrationDatabase,
  ) => Promise<Result>,
): Promise<Result> {
  const mode = registrationMode();
  if (mode === 'off') {
    throw new GraphQLError('Developer apps are not available.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (mode === 'hold') {
    throw new GraphQLError('Developer apps are paused. Try again shortly.', {
      extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: RETRY_AFTER_SECONDS },
    });
  }
  requireAuthenticated(ctx);
  const developerId = ctx.userId;
  if (!developerId) throw new Error('Authentication required to perform this operation');
  await chargeDeveloperLimit(ctx, kind);
  if (mode !== 'open') await requireInvitedDeveloper(developerId);
  if (
    mode === 'open' &&
    !(await hasVerifiedPartnerDeveloperEmail(db as unknown as RegistrationDatabase, developerId))
  ) {
    throw new GraphQLError('Verify your developer email before registering apps.', {
      extensions: { code: 'FORBIDDEN', reason: 'EMAIL_NOT_VERIFIED' },
    });
  }
  await chargeAddressLimit(ctx, kind);

  let runtime: PartnerRuntime | null;
  try {
    runtime = await loadPartnerAuthority(mode);
  } catch (error) {
    logger.error('Partner OAuth could not start for registration', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    runtime = null;
  }
  if (!runtime) {
    throw new GraphQLError('Developer apps are unavailable. Try again shortly.', {
      extensions: { code: 'SERVICE_UNAVAILABLE' },
    });
  }

  try {
    // The GraphQL pool, like every other mutation; the partner pool stays for OAuth traffic.
    return await work(runtime.registration, developerId, db as unknown as RegistrationDatabase);
  } catch (error) {
    if (error instanceof PartnerRegistrationError) throw refusalError(error);
    // Name and database code only: a query error's text carries its parameters.
    logger.error('Partner app registration failed', {
      developerId,
      errorName: error instanceof Error ? error.name : 'unknown',
      postgresCode: getPostgresErrorCode(error),
    });
    throw new GraphQLError('Something went wrong. Try again.', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
  }
}

const APPLICATION_TYPES = { web: 'WEB', native: 'NATIVE' } as const;
const AUTH_METHODS = {
  none: 'NONE',
  client_secret_basic: 'CLIENT_SECRET_BASIC',
  client_secret_post: 'CLIENT_SECRET_POST',
} as const;

function lowerCaseEnum(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function toOAuthClient(record: PartnerAppRecord): OAuthClient {
  return {
    clientId: record.clientId,
    name: record.name,
    publisherName: record.publisherName,
    homepageUrl: record.homepageUrl,
    privacyPolicyUrl: record.privacyPolicyUrl,
    applicationType: APPLICATION_TYPES[record.applicationType],
    tokenEndpointAuthMethod: AUTH_METHODS[record.tokenEndpointAuthMethod],
    redirectUris: record.redirectUris,
    createdAt: record.createdAt.toISOString(),
    suspendedAt: record.suspendedAt?.toISOString() ?? null,
    suspensionReason: record.suspensionReason,
    maxActiveConnections: record.maxActiveConnections,
    maxNewConnectionsPerDay: record.maxNewConnectionsPerDay,
    activeConnections: record.activeConnections,
  };
}

function toCredentials(credentials: PartnerAppCredentials): OAuthClientCredentials {
  return { client: toOAuthClient(credentials.app), clientSecret: credentials.clientSecret };
}

function clientIdArgument(clientId: unknown): string {
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 128) {
    throw new GraphQLError('Invalid client ID.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return clientId;
}

/** Proof operations need no proof themselves; allowlist mode still requires an invite. */
async function withDeveloperEmail<Result>(
  ctx: ConnectionContext,
  kind: 'read' | 'write',
  work: (database: RegistrationDatabase, userId: string) => Promise<Result>,
): Promise<Result> {
  const mode = registrationMode();
  if (mode === 'off')
    throw new GraphQLError('Developer apps are not available.', { extensions: { code: 'NOT_FOUND' } });
  if (mode === 'hold')
    throw new GraphQLError('Developer apps are paused.', {
      extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 60 },
    });
  requireAuthenticated(ctx);
  if (!ctx.userId) throw new GraphQLError('Sign in first.', { extensions: { code: 'UNAUTHENTICATED' } });
  await chargeDeveloperLimit(ctx, kind, 'email');
  if (mode !== 'open') await requireInvitedDeveloper(ctx.userId);
  // Verification traffic has its own address bucket; unverified accounts cannot spend app writes.
  await chargeAddressLimit(ctx, kind, 'email');
  try {
    return await work(db as unknown as RegistrationDatabase, ctx.userId);
  } catch (error) {
    if (error instanceof PartnerRegistrationError) throw refusalError(error);
    logger.error('Developer email verification failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    throw new GraphQLError('Email verification is unavailable. Try again.', {
      extensions: { code: 'SERVICE_UNAVAILABLE' },
    });
  }
}

export const oauthClientQueries = {
  partnerDeveloperEmailStatus: (_: unknown, _args: unknown, ctx: ConnectionContext) =>
    withDeveloperEmail(ctx, 'read', readPartnerDeveloperEmailStatus),
  myOAuthClients: (_: unknown, _args: unknown, ctx: ConnectionContext): Promise<OAuthClient[]> =>
    withRegistration(ctx, 'read', async (registration, developerId, database) =>
      (await registration.listApps(database, developerId)).map(toOAuthClient),
    ),
};

export const oauthClientMutations = {
  requestPartnerDeveloperEmail: (_: unknown, _args: unknown, ctx: ConnectionContext) =>
    withDeveloperEmail(ctx, 'write', async (database, userId) => {
      await requestPartnerDeveloperEmail(database, userId, sendPartnerDeveloperVerificationEmail);
      return true;
    }),
  confirmPartnerDeveloperEmail: (_: unknown, { token }: { token: string }, ctx: ConnectionContext) =>
    withDeveloperEmail(ctx, 'write', (database, userId) => confirmPartnerDeveloperEmail(database, userId, token)),
  createOAuthClient: (
    _: unknown,
    { input }: { input: CreateOAuthClientInput },
    ctx: ConnectionContext,
  ): Promise<OAuthClientCredentials> =>
    withRegistration(ctx, 'write', async (registration, developerId, database) =>
      toCredentials(
        await registration.createApp(
          database,
          developerId,
          {
            name: input.name,
            publisherName: input.publisherName,
            homepageUrl: input.homepageUrl,
            privacyPolicyUrl: input.privacyPolicyUrl,
            applicationType: lowerCaseEnum(input.applicationType),
            tokenEndpointAuthMethod: lowerCaseEnum(input.tokenEndpointAuthMethod),
            redirectUris: input.redirectUris,
            acceptedTermsVersion: input.acceptedTermsVersion,
          },
          { requireEmailProof: registrationMode() === 'open' },
        ),
      ),
    ),

  updateOAuthClient: (
    _: unknown,
    { input }: { input: UpdateOAuthClientInput },
    ctx: ConnectionContext,
  ): Promise<OAuthClient> =>
    withRegistration(ctx, 'write', async (registration, developerId, database) => {
      const { clientId, ...patch } = input;
      return toOAuthClient(
        await registration.updateApp(
          database,
          developerId,
          clientIdArgument(clientId),
          {
            ...('name' in patch ? { name: patch.name } : {}),
            ...('publisherName' in patch ? { publisherName: patch.publisherName } : {}),
            ...('homepageUrl' in patch ? { homepageUrl: patch.homepageUrl } : {}),
            ...('privacyPolicyUrl' in patch ? { privacyPolicyUrl: patch.privacyPolicyUrl } : {}),
            ...('redirectUris' in patch ? { redirectUris: patch.redirectUris } : {}),
          },
          ctx.webSignIn,
        ),
      );
    }),

  // Rotate and delete, and an edit that changes the redirect URIs, need a sign-in
  // from the last five minutes: `ctx.webSignIn`, which only HTTP authentication sets.
  rotateOAuthClientSecret: (
    _: unknown,
    { clientId }: { clientId: string },
    ctx: ConnectionContext,
  ): Promise<OAuthClientCredentials> =>
    withRegistration(ctx, 'write', async (registration, developerId, database) =>
      toCredentials(await registration.rotateSecret(database, developerId, clientIdArgument(clientId), ctx.webSignIn)),
    ),

  deleteOAuthClient: (_: unknown, { clientId }: { clientId: string }, ctx: ConnectionContext): Promise<boolean> =>
    withRegistration(ctx, 'write', (registration, developerId, database) =>
      registration.deleteApp(database, developerId, clientIdArgument(clientId), ctx.webSignIn),
    ),
};
