import { GraphQLError } from 'graphql';
import type {
  ConnectionContext,
  CreateOAuthClientInput,
  OAuthClient,
  OAuthClientCredentials,
  UpdateOAuthClientInput,
} from '@boardsesh/shared-schema';
import { loadPartnerAuthority } from '../../../auth/partner/load-authority';
import { readPartnerOAuthMode, type PartnerOAuthMode } from '../../../auth/partner/mode';
import {
  parsePartnerDeveloperAllowlist,
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
const HOLD_RETRY_AFTER_SECONDS = 60;

interface RegistrationDeployment {
  mode: PartnerOAuthMode;
  developerAllowlist: ReadonlySet<string>;
}

let deployment: RegistrationDeployment | undefined;

/** Read once, from the environment. No request can choose either value. */
function registrationDeployment(): RegistrationDeployment {
  deployment ??= {
    mode: readPartnerOAuthMode(),
    developerAllowlist: parsePartnerDeveloperAllowlist(process.env.PARTNER_OAUTH_DEVELOPER_ALLOWLIST),
  };
  return deployment;
}

export function __resetPartnerRegistrationDeploymentForTests(): void {
  deployment = undefined;
}

function rateLimited(error: RateLimitError, operation: string): GraphQLError {
  return new GraphQLError(error.message, {
    extensions: { code: 'RATE_LIMITED', operation, retryAfterSeconds: error.retryAfterSeconds },
  });
}

function limitOperation(kind: 'read' | 'write'): string {
  return kind === 'write' ? 'oauthClientWrite' : 'oauthClientRead';
}

/** Charged only once the caller is a signed-in account, and only that account can spend it. */
async function chargeDeveloperLimit(ctx: ConnectionContext, kind: 'read' | 'write'): Promise<void> {
  await applyRateLimit(ctx, kind === 'write' ? WRITES_PER_DEVELOPER : READS_PER_DEVELOPER, limitOperation(kind));
}

/**
 * Charged only for an allowlisted developer, so throwaway accounts behind the
 * same address cannot fill it. Keyed by `trustedClientIp`, which believes
 * `cf-connecting-ip` only from a verified Cloudflare edge and groups an IPv6
 * client by its /64, so a direct-origin caller cannot choose the bucket.
 */
async function chargeAddressLimit(ctx: ConnectionContext, kind: 'read' | 'write'): Promise<void> {
  const operation = limitOperation(kind);
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
  not_found: 'NOT_FOUND',
  busy: 'SERVICE_UNAVAILABLE',
};

function refusalError(error: PartnerRegistrationError): GraphQLError {
  return new GraphQLError(error.message, {
    extensions: { code: REFUSAL_CODES[error.reason], reason: error.reason.toUpperCase() },
  });
}

/**
 * Every operation's way in. The order is the contract: the mode first, so an
 * off deployment does nothing at all; then the account and its own limit; then
 * the allowlist; then the address limit, which only listed developers spend. `open` registers allowlisted developers only, like
 * `allowlist`, until a developer's email has a real proof of ownership
 * (BA-02, or registration's own email check): `emailVerified` was stamped
 * without one while verification was off.
 */
async function withRegistration<Result>(
  ctx: ConnectionContext,
  kind: 'read' | 'write',
  work: (
    registration: PartnerRegistrationService,
    developerId: string,
    database: RegistrationDatabase,
  ) => Promise<Result>,
): Promise<Result> {
  const { mode, developerAllowlist } = registrationDeployment();
  if (mode === 'off') {
    throw new GraphQLError('Developer apps are not available.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (mode === 'hold') {
    throw new GraphQLError('Developer apps are paused. Try again shortly.', {
      extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: HOLD_RETRY_AFTER_SECONDS },
    });
  }
  requireAuthenticated(ctx);
  const developerId = ctx.userId;
  if (!developerId) throw new Error('Authentication required to perform this operation');
  await chargeDeveloperLimit(ctx, kind);
  if (!developerAllowlist.has(developerId)) {
    throw new GraphQLError('Developer apps are invite-only for now.', {
      extensions: { code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' },
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

export const oauthClientQueries = {
  myOAuthClients: (_: unknown, _args: unknown, ctx: ConnectionContext): Promise<OAuthClient[]> =>
    withRegistration(ctx, 'read', async (registration, developerId, database) =>
      (await registration.listApps(database, developerId)).map(toOAuthClient),
    ),
};

export const oauthClientMutations = {
  createOAuthClient: (
    _: unknown,
    { input }: { input: CreateOAuthClientInput },
    ctx: ConnectionContext,
  ): Promise<OAuthClientCredentials> =>
    withRegistration(ctx, 'write', async (registration, developerId, database) =>
      toCredentials(
        await registration.createApp(database, developerId, {
          name: input.name,
          publisherName: input.publisherName,
          homepageUrl: input.homepageUrl,
          privacyPolicyUrl: input.privacyPolicyUrl,
          applicationType: lowerCaseEnum(input.applicationType),
          tokenEndpointAuthMethod: lowerCaseEnum(input.tokenEndpointAuthMethod),
          redirectUris: input.redirectUris,
          acceptedTermsVersion: input.acceptedTermsVersion,
        }),
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
        await registration.updateApp(database, developerId, clientIdArgument(clientId), {
          ...('name' in patch ? { name: patch.name } : {}),
          ...('publisherName' in patch ? { publisherName: patch.publisherName } : {}),
          ...('homepageUrl' in patch ? { homepageUrl: patch.homepageUrl } : {}),
          ...('privacyPolicyUrl' in patch ? { privacyPolicyUrl: patch.privacyPolicyUrl } : {}),
          ...('redirectUris' in patch ? { redirectUris: patch.redirectUris } : {}),
        }),
      );
    }),

  rotateOAuthClientSecret: (
    _: unknown,
    { clientId }: { clientId: string },
    ctx: ConnectionContext,
  ): Promise<OAuthClientCredentials> =>
    withRegistration(ctx, 'write', async (registration, developerId, database) =>
      toCredentials(await registration.rotateSecret(database, developerId, clientIdArgument(clientId))),
    ),

  deleteOAuthClient: (_: unknown, { clientId }: { clientId: string }, ctx: ConnectionContext): Promise<boolean> =>
    withRegistration(ctx, 'write', (registration, developerId, database) =>
      registration.deleteApp(database, developerId, clientIdArgument(clientId)),
    ),
};
