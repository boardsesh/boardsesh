import {
  betterAuth,
  type Auth,
  type BetterAuthOptions,
  type BetterAuthPlugin,
  type GenericEndpointContext,
} from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { getOAuthProviderApi, oauthProvider, type OAuthOptions } from '@better-auth/oauth-provider';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDedicatedPool, withConnectRetry } from '@boardsesh/db/client';
import { oauthConnections, oauthRefreshToken } from '@boardsesh/db/schema/auth';
import { guardPartnerAdapter } from './adapter-guard';
import { createPartnerAdmissionGate, type PartnerAdmissionGate, type PartnerAdmissionLimits } from './admission';
import { createPartnerApiAccess, type PartnerApiAccess } from './api-access';
import {
  assertPartnerTelemetryOff,
  PARTNER_SCOPES,
  PARTNER_SIGNED_QUERY_LIFETIME_SECONDS,
  readPartnerAuthorityConfiguration,
  type PartnerAuthorityConfiguration,
} from './configuration';
import { partnerFencePlugin } from './fence';
import { createPartnerOriginDirectory, type PartnerRegisteredOrigins } from './registered-origins';
import { PARTNER_DISABLED_PATHS } from './routes';
import { partnerAdapterSchema, type PartnerDatabase } from './tables';
import {
  createPartnerDatabaseHandle,
  handlePartnerRequest,
  PARTNER_POOL_MAX,
  type PartnerRequestOptions,
} from './transaction';

export type PartnerAuthorityOptions = BetterAuthOptions & {
  plugins: [ReturnType<typeof oauthProvider>, ...BetterAuthPlugin[]];
};
export type PartnerAuthority = Auth<PartnerAuthorityOptions>;

/** The connection a refresh token belongs to, found before any lock is taken. */
export interface PartnerRefreshConnection {
  clientId: string;
  connectionId: string;
}

/** Everything the HTTP routes need. Built only when the mode is not `off`. */
export interface PartnerAuthorityRuntime {
  authority: PartnerAuthority;
  database: PartnerDatabase;
  configuration: PartnerAuthorityConfiguration;
  admission: PartnerAdmissionGate;
  registeredOrigins: PartnerRegisteredOrigins;
  handleRequest(request: Request, options?: PartnerRequestOptions): Promise<Response>;
  /** The published RFC 8414 document, built once. Reads no table. */
  discoveryResponse(logContext?: PartnerRequestOptions['logContext']): Promise<Response>;
  /**
   * The connection of a refresh token that can still be used: not consumed and
   * not expired. A consumed one has no connection here, so presenting an old
   * token, with or without the client secret, cannot spend that connection's limit.
   */
  findRefreshConnection(refreshToken: string): Promise<PartnerRefreshConnection | null>;
  /** The `/v1` resource server: bearer check, `/v1/me` and `DELETE /v1/connection`. */
  api: PartnerApiAccess;
  close(): Promise<void>;
}

export const PARTNER_ADMISSION_LIMITS: PartnerAdmissionLimits = {
  permits: PARTNER_POOL_MAX,
  authorizePermits: 1,
  apiPermits: PARTNER_POOL_MAX - 1,
  queueLimitPerLane: 16,
  queueDeadlineMs: 1000,
};

/**
 * Only what is reachable. Stock also advertises `introspection_endpoint`,
 * `private_key_jwt`, signing algorithms and DPoP, none of which this server offers.
 */
const PUBLISHED_METADATA_FIELDS = [
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'revocation_endpoint',
  'scopes_supported',
  'response_types_supported',
  'response_modes_supported',
  'grant_types_supported',
  'code_challenge_methods_supported',
  'authorization_response_iss_parameter_supported',
] as const;

/** `docs/partner-api.md` section 2: confidential apps use Basic or POST, public apps `none`. */
const PARTNER_CLIENT_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'];

const DISCOVERY_CACHE_CONTROL = 'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400';

export function publishedPartnerMetadata(stockMetadata: object): Record<string, unknown> {
  const published: Record<string, unknown> = {};
  for (const field of PUBLISHED_METADATA_FIELDS) {
    const value = (stockMetadata as Record<string, unknown>)[field];
    if (value !== undefined) published[field] = value;
  }
  published.token_endpoint_auth_methods_supported = PARTNER_CLIENT_AUTH_METHODS;
  published.revocation_endpoint_auth_methods_supported = PARTNER_CLIENT_AUTH_METHODS;
  return published;
}

export function partnerOAuthOptions(configuration: PartnerAuthorityConfiguration) {
  return {
    loginPage: `${configuration.webOrigin}/oauth/sign-in`,
    consentPage: `${configuration.webOrigin}/oauth/consent`,
    disableJwtPlugin: true,
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    grantTypes: ['authorization_code', 'refresh_token'],
    scopes: PARTNER_SCOPES,
    resources: [configuration.resource],
    enforcePerClientResources: true,
    accessTokenExpiresIn: 3600,
    refreshTokenExpiresIn: 90 * 24 * 60 * 60,
    refreshTokenReuseInterval: 0,
    codeExpiresIn: PARTNER_SIGNED_QUERY_LIFETIME_SECONDS,
    storeTokens: 'hashed',
    storeClientSecret: 'encrypted',
    clientRegistrationRequirePKCE: true,
  } satisfies OAuthOptions<string[]>;
}

/**
 * The partner authority: Better Auth used only as an OAuth server, on today's
 * `users` table. Email and social sign-in stay off and identity rows are
 * read-only. Building one starts telemetry in the library, so the flag is
 * checked first, and nothing here runs at import.
 *
 * `plugins` run before the fence, which is where the consent bridge goes: it
 * sets `ctx.context.session` for the fence and the provider to find.
 *
 * `disabledPaths` defaults to every route the plan does not name. Only the
 * authority's own test suite, which exercises stock routes directly, changes it.
 */
export function createPartnerAuthority(
  database: PartnerDatabase,
  configuration: PartnerAuthorityConfiguration,
  { plugins = [], disabledPaths = PARTNER_DISABLED_PATHS }: PartnerAuthorityBuildOptions = {},
): PartnerAuthority {
  assertPartnerTelemetryOff();
  const oauthOptions = partnerOAuthOptions(configuration);
  const authorityOptions: PartnerAuthorityOptions = {
    appName: 'Boardsesh partner OAuth',
    baseURL: configuration.issuer,
    // Legacy-format ciphertext falls back to `secret`; keep it on our own value.
    secret: configuration.secrets[0].value,
    secrets: configuration.secrets,
    trustedOrigins: [configuration.webOrigin],
    disabledPaths: [...disabledPaths],
    emailAndPassword: { enabled: false },
    user: { modelName: 'users', changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: { modelName: 'oauthSession', cookieCache: { enabled: false } },
    verification: { modelName: 'oauthVerification' },
    account: { accountLinking: { enabled: false } },
    advanced: {
      // `account` is deliberately absent, so the runtime check would fail every
      // request. The partner tests assert it is the only finding.
      database: { validateSchema: false },
      // Better Auth otherwise skips these under NODE_ENV=test.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    logger: { disabled: true },
    // Otherwise the router prints unexpected errors, with their query parameters,
    // to the console. handlePartnerRequest logs them by name and code instead.
    onAPIError: { throw: true },
    database: guardPartnerAdapter(
      drizzleAdapter(createPartnerDatabaseHandle(database), {
        provider: 'pg',
        schema: partnerAdapterSchema,
        // The handle already follows the request transaction.
        transaction: false,
      }),
    ),
    plugins: [oauthProvider(oauthOptions), ...plugins, partnerFencePlugin(oauthOptions)],
  };
  return betterAuth(authorityOptions);
}

interface PartnerAuthorityBuildOptions {
  plugins?: BetterAuthPlugin[];
  disabledPaths?: readonly string[];
}

/**
 * Assembles the runtime around one authority. Exported so the route tests run
 * the same object production does, against a test issuer.
 */
export async function createPartnerAuthorityRuntime(
  database: PartnerDatabase,
  configuration: PartnerAuthorityConfiguration,
  { close, ...buildOptions }: PartnerAuthorityBuildOptions & { close: () => Promise<void> },
): Promise<PartnerAuthorityRuntime> {
  const authority = createPartnerAuthority(database, configuration, buildOptions);
  await authority.$context;
  const oauthOptions = partnerOAuthOptions(configuration);
  // hashToken never reads the endpoint context; only client authentication does.
  const tokenHasher = getOAuthProviderApi({} as GenericEndpointContext, oauthOptions);
  const hashRefreshToken = (refreshToken: string) => tokenHasher.hashToken(refreshToken, 'refresh_token');
  const publishedDiscovery = JSON.stringify(publishedPartnerMetadata(await authority.api.getOAuthServerConfig()));

  return {
    authority,
    database,
    configuration,
    admission: createPartnerAdmissionGate(PARTNER_ADMISSION_LIMITS),
    registeredOrigins: createPartnerOriginDirectory(database),
    handleRequest: (request, options) => handlePartnerRequest(database, request, authority.handler, options),
    discoveryResponse: (logContext) =>
      handlePartnerRequest(
        database,
        // Goes through the wrapper so a failure here answers like every other route.
        new Request(`${configuration.issuer}/.well-known/oauth-authorization-server`),
        async () =>
          new Response(publishedDiscovery, {
            headers: { 'content-type': 'application/json', 'cache-control': DISCOVERY_CACHE_CONTROL },
          }),
        { transaction: false, logContext },
      ),
    async findRefreshConnection(refreshToken) {
      const tokenHash = await hashRefreshToken(refreshToken);
      const [current] = await database
        .select({ clientId: oauthConnections.clientId, connectionId: oauthConnections.id })
        .from(oauthRefreshToken)
        .innerJoin(
          oauthConnections,
          and(
            eq(oauthConnections.clientId, oauthRefreshToken.clientId),
            eq(oauthConnections.userId, oauthRefreshToken.userId),
          ),
        )
        .where(
          and(
            eq(oauthRefreshToken.token, tokenHash),
            isNull(oauthRefreshToken.revoked),
            gt(oauthRefreshToken.expiresAt, new Date()),
          ),
        );
      return current ?? null;
    },
    api: createPartnerApiAccess({
      database,
      resource: configuration.resource,
      hashAccessToken: async (accessToken) => tokenHasher.hashToken(accessToken, 'access_token'),
    }),
    close,
  };
}

async function buildPartnerAuthorityRuntime(): Promise<PartnerAuthorityRuntime> {
  const configuration = readPartnerAuthorityConfiguration();
  const pool = createDedicatedPool(PARTNER_POOL_MAX);
  const database = drizzle(withConnectRetry(pool), { schema: partnerAdapterSchema });
  return createPartnerAuthorityRuntime(database, configuration, { close: () => pool.end() });
}

let runtime: Promise<PartnerAuthorityRuntime> | undefined;

/** One authority for the process. Reached only through `loadPartnerAuthority`. */
export function getPartnerAuthorityRuntime(): Promise<PartnerAuthorityRuntime> {
  runtime ??= buildPartnerAuthorityRuntime().catch((error) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}
