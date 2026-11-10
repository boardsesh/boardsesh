import { betterAuth, type Auth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { oauthProvider, type OAuthOptions } from '@better-auth/oauth-provider';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDedicatedPool, withConnectRetry } from '@boardsesh/db/client';
import { guardPartnerAdapter } from './adapter-guard';
import {
  assertPartnerTelemetryOff,
  PARTNER_SCOPES,
  PARTNER_SIGNED_QUERY_LIFETIME_SECONDS,
  readPartnerAuthorityConfiguration,
  type PartnerAuthorityConfiguration,
} from './configuration';
import { partnerFencePlugin } from './fence';
import { partnerAdapterSchema, type PartnerDatabase } from './tables';
import { createPartnerDatabaseHandle, handlePartnerRequest, PARTNER_POOL_MAX } from './transaction';

export type PartnerAuthorityOptions = BetterAuthOptions & {
  plugins: [ReturnType<typeof oauthProvider>, ...BetterAuthPlugin[]];
};
export type PartnerAuthority = Auth<PartnerAuthorityOptions>;

export interface PartnerAuthorityRuntime {
  authority: PartnerAuthority;
  database: PartnerDatabase;
  handleRequest(request: Request): Promise<Response>;
  close(): Promise<void>;
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
 */
export function createPartnerAuthority(
  database: PartnerDatabase,
  configuration: PartnerAuthorityConfiguration,
  { plugins = [] }: { plugins?: BetterAuthPlugin[] } = {},
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

async function buildPartnerAuthorityRuntime(): Promise<PartnerAuthorityRuntime> {
  const configuration = readPartnerAuthorityConfiguration();
  const pool = createDedicatedPool(PARTNER_POOL_MAX);
  const database = drizzle(withConnectRetry(pool), { schema: partnerAdapterSchema });
  const authority = createPartnerAuthority(database, configuration);
  await authority.$context;
  return {
    authority,
    database,
    handleRequest: (request) => handlePartnerRequest(database, request, authority.handler),
    close: () => pool.end(),
  };
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
