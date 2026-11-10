import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { oauthAppPolicy, oauthClientResource, oauthSession, users } from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { createPartnerAuthority, partnerOAuthOptions, type PartnerAuthority } from '../authority';
import type { PartnerAuthorityConfiguration } from '../configuration';
import { createPartnerDatabaseHandle, handlePartnerRequest } from '../transaction';
import { partnerAdapterSchema, type PartnerDatabase } from '../tables';

/** A published (non-draft) terms version, so tests can register apps whatever the shipped terms say. */
export const TEST_DEVELOPER_TERMS_VERSION = 'test-terms-2026-11-10';

export const TEST_CONFIGURATION: PartnerAuthorityConfiguration = {
  issuer: 'https://api.boardsesh.test/api/auth',
  resource: 'https://api.boardsesh.test/v1',
  webOrigin: 'https://www.boardsesh.test',
  secrets: [{ version: 1, value: 'partner-oauth-test-secret-never-deployed-0123456789' }],
  // The backend test setup sets NEXTAUTH_SECRET to this, so cookies the real
  // NextAuth encoder writes in a test decrypt here too.
  nextAuthSecret: process.env.NEXTAUTH_SECRET ?? 'boardsesh-test-session-identity-secret',
  developerTermsVersion: TEST_DEVELOPER_TERMS_VERSION,
};

export const TEST_OAUTH_OPTIONS = partnerOAuthOptions(TEST_CONFIGURATION);
export const TEST_ISSUER = TEST_CONFIGURATION.issuer;
export const TEST_RESOURCE = TEST_CONFIGURATION.resource;

/** The header the test session bridge reads. It holds an `oauth_session` token. */
export const TEST_SESSION_HEADER = 'x-boardsesh-test-session';
/** The route tests send a NextAuth-named cookie instead, because the routes forward only known headers. */
export const TEST_SESSION_COOKIE = 'next-auth.session-token';

function sessionTokenFromCookie(cookieHeader: string | null | undefined): string | undefined {
  return cookieHeader
    ?.split('; ')
    .find((pair) => pair.startsWith(`${TEST_SESSION_COOKIE}=`))
    ?.slice(TEST_SESSION_COOKIE.length + 1);
}

/**
 * Stands in for the consent bridge (F13). It sets `ctx.context.session` from an
 * `oauth_session` row, the mechanism proof (b) exists to confirm. Runs before the
 * fence, like the real bridge will.
 */
export function testSessionBridge(database: PartnerDatabase): BetterAuthPlugin {
  return {
    id: 'test-consent-bridge',
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (context) => {
            const token =
              context.headers?.get(TEST_SESSION_HEADER) ?? sessionTokenFromCookie(context.headers?.get('cookie'));
            if (!token) return;
            const [session] = await database.select().from(oauthSession).where(eq(oauthSession.token, token));
            if (!session) return;
            const [user] = await database.select().from(users).where(eq(users.id, session.userId));
            context.context.session = {
              session,
              user,
            } as unknown as NonNullable<typeof context.context.session>;
          }),
        },
      ],
    },
  };
}

export interface TestClimber {
  userId: string;
  sessionToken: string;
  sessionId: string;
}

export interface TestClient {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  owner: TestClimber;
}

export interface OAuthResponseBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  active?: boolean;
  aud?: string | string[];
  sub?: string;
  client_id?: string;
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  url?: string;
}

export interface RequestHandlerInstance {
  handler: (request: Request) => Promise<Response>;
}

export const READ_ONLY_PROOF_APPLICATION_NAME = 'partner-oauth-read-only-proof';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must point at the worker database.');
  return url;
}

export function createAuthorityDatabase(applicationName = READ_ONLY_PROOF_APPLICATION_NAME): {
  database: PartnerDatabase;
  close(): Promise<void>;
} {
  const client = postgres(databaseUrl(), {
    max: 3,
    onnotice: () => {},
    connection: { application_name: applicationName },
  });
  return { database: drizzle(client, { schema: partnerAdapterSchema }), close: () => client.end({ timeout: 5 }) };
}

export interface PartnerTestEnvironment {
  database: PartnerDatabase;
  auth: PartnerAuthority;
  secondaryAuth: PartnerAuthority;
  /** Instance one, through the transaction wrapper every route will use. */
  instance: RequestHandlerInstance;
  /** Instance two, on its own pool. */
  secondaryInstance: RequestHandlerInstance;
  createInstance(plugins?: BetterAuthPlugin[]): RequestHandlerInstance;
  createClimber(): Promise<TestClimber>;
  createClient(options?: {
    publicClient?: boolean;
    skipConsent?: boolean;
    owner?: TestClimber;
    linkResource?: boolean;
    redirectOrigin?: string;
    /** For a confidential client. Defaults to `client_secret_post`. */
    secretMethod?: 'client_secret_post' | 'client_secret_basic';
    /** The app's caps, or false for an app with no policy row. Defaults to decision 22's 25 and 20. */
    policy?: { maxActiveConnections?: number; maxNewConnectionsPerDay?: number; publisherName?: string } | false;
  }): Promise<TestClient>;
  authorize(
    client: TestClient,
    options?: {
      scopes?: string[];
      challengeMethod?: string;
      omitChallenge?: boolean;
      resource?: string;
      /** Leave `resource` off the request entirely. */
      omitResource?: boolean;
      climber?: TestClimber;
      prompt?: string;
    },
    target?: RequestHandlerInstance,
  ): Promise<{ response: Response; location: string | null; verifier: string; state: string | null }>;
  exchange(
    client: TestClient,
    authorization: { location: string | null; verifier: string },
    target?: RequestHandlerInstance,
    overrides?: Record<string, string>,
  ): Promise<{ response: Response; body: OAuthResponseBody }>;
  issueTokens(
    client: TestClient,
    scopes?: string[],
    target?: RequestHandlerInstance,
  ): Promise<OAuthResponseBody & { access_token: string }>;
  refresh(
    client: TestClient,
    token: string,
    target?: RequestHandlerInstance,
    scope?: string,
  ): Promise<{ response: Response; body: OAuthResponseBody }>;
  introspect(
    client: TestClient,
    token: string,
    target?: RequestHandlerInstance,
  ): Promise<{ response: Response; body: OAuthResponseBody }>;
  revoke(
    client: TestClient,
    fields: Record<string, string>,
    target?: RequestHandlerInstance,
  ): Promise<{ response: Response; body: OAuthResponseBody }>;
  consent(
    climber: TestClimber,
    body: Record<string, unknown>,
    target?: RequestHandlerInstance,
  ): Promise<{ response: Response; body: OAuthResponseBody }>;
  close(): Promise<void>;
}

export async function postForm(
  target: RequestHandlerInstance,
  path: string,
  fields: Record<string, string> | URLSearchParams,
) {
  const response = await target.handler(
    new Request(`${TEST_ISSUER}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    }),
  );
  const responseText = await response.text();
  return { response, body: (responseText ? JSON.parse(responseText) : {}) as OAuthResponseBody };
}

export function clientCredentials(client: TestClient): Record<string, string> {
  return { client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) };
}

export async function createPartnerTestEnvironment(): Promise<PartnerTestEnvironment> {
  const primary = createAuthorityDatabase();
  const secondary = createAuthorityDatabase();

  function buildAuthority(database: PartnerDatabase, plugins: BetterAuthPlugin[] = []): PartnerAuthority {
    return createPartnerAuthority(database, TEST_CONFIGURATION, {
      plugins: [testSessionBridge(createPartnerDatabaseHandle(database)), ...plugins],
      // These suites exercise stock routes directly (introspection, the sign-in
      // refusals). The disabled list is proven in the route suite.
      disabledPaths: [],
    });
  }
  const instanceFor = (database: PartnerDatabase, authority: PartnerAuthority): RequestHandlerInstance => ({
    handler: (request) => handlePartnerRequest(database, request, authority.handler),
  });

  const auth = buildAuthority(primary.database);
  const secondaryAuth = buildAuthority(secondary.database);
  await Promise.all([auth.$context, secondaryAuth.$context]);
  const instance = instanceFor(primary.database, auth);
  const secondaryInstance = instanceFor(secondary.database, secondaryAuth);

  const environment: PartnerTestEnvironment = {
    database: primary.database,
    auth,
    secondaryAuth,
    instance,
    secondaryInstance,
    createInstance: (plugins) => instanceFor(primary.database, buildAuthority(primary.database, plugins)),

    async createClimber() {
      const userId = randomUUID();
      const sessionId = randomUUID();
      const sessionToken = `test-session-${randomUUID()}`;
      await db.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
      await db.insert(oauthSession).values({
        id: sessionId,
        token: sessionToken,
        userId,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        updatedAt: new Date(),
      });
      return { userId, sessionId, sessionToken };
    },

    async createClient(options = {}) {
      const owner = options.owner ?? (await environment.createClimber());
      const identifier = randomUUID();
      const redirectUri = `${options.redirectOrigin ?? 'https://client.example.test'}/callback/${identifier}`;
      const registered = await auth.api.adminCreateOAuthClient({
        headers: new Headers({ [TEST_SESSION_HEADER]: owner.sessionToken }),
        body: {
          client_name: 'Partner authority fixture',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: options.publicClient ? 'none' : (options.secretMethod ?? 'client_secret_post'),
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: TEST_OAUTH_OPTIONS.scopes.join(' '),
          require_pkce: true,
          skip_consent: options.skipConsent ?? true,
        },
      });
      if (!registered?.client_id) throw new Error('Fixture client registration did not return an id');
      // Registration (F12) writes this row; an app without one cannot gain connections.
      if (options.policy !== false) {
        await db.insert(oauthAppPolicy).values({
          clientId: registered.client_id,
          ownerUserId: owner.userId,
          ...options.policy,
        });
      }
      if (options.linkResource ?? true) {
        await db.insert(oauthClientResource).values({
          id: randomUUID(),
          clientId: registered.client_id,
          resourceId: TEST_RESOURCE,
          createdAt: new Date(),
        });
      }
      return {
        clientId: registered.client_id,
        clientSecret: registered.client_secret ?? undefined,
        redirectUri,
        owner,
      };
    },

    async authorize(client, options = {}, target = instance) {
      const verifier = randomBytes(32).toString('base64url');
      const authorization = new URL(`${TEST_ISSUER}/oauth2/authorize`);
      authorization.search = new URLSearchParams({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        scope: (options.scopes ?? ['profile:read', 'offline_access']).join(' '),
        state: randomUUID(),
        ...(options.omitResource ? {} : { resource: options.resource ?? TEST_RESOURCE }),
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.omitChallenge
          ? {}
          : {
              code_challenge: createHash('sha256').update(verifier).digest('base64url'),
              code_challenge_method: options.challengeMethod ?? 'S256',
            }),
      }).toString();
      const climber = options.climber ?? client.owner;
      const response = await target.handler(
        new Request(authorization, { headers: { [TEST_SESSION_HEADER]: climber.sessionToken } }),
      );
      return {
        response,
        location: response.headers.get('location'),
        verifier,
        state: authorization.searchParams.get('state'),
      };
    },

    async exchange(client, authorization, target = instance, overrides = {}) {
      if (!authorization.location) throw new Error('Authorization did not return a redirect');
      const code = new URL(authorization.location).searchParams.get('code');
      if (!code) throw new Error(`Authorization did not return a code: ${authorization.location}`);
      return postForm(target, '/oauth2/token', {
        grant_type: 'authorization_code',
        code,
        code_verifier: authorization.verifier,
        redirect_uri: client.redirectUri,
        ...clientCredentials(client),
        ...overrides,
      });
    },

    async issueTokens(client, scopes, target = instance) {
      const authorization = await environment.authorize(client, { scopes }, target);
      const issued = await environment.exchange(client, authorization, target);
      if (issued.response.status !== 200 || !issued.body.access_token) {
        throw new Error(`Token exchange failed: ${issued.response.status} ${JSON.stringify(issued.body)}`);
      }
      return issued.body as OAuthResponseBody & { access_token: string };
    },

    refresh(client, token, target = secondaryInstance, scope) {
      return postForm(target, '/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: token,
        ...clientCredentials(client),
        ...(scope ? { scope } : {}),
      });
    },

    introspect(client, token, target = secondaryInstance) {
      return postForm(target, '/oauth2/introspect', { token, ...clientCredentials(client) });
    },

    revoke(client, fields, target = secondaryInstance) {
      return postForm(target, '/oauth2/revoke', { ...clientCredentials(client), ...fields });
    },

    async consent(climber, body, target = instance) {
      const response = await target.handler(
        new Request(`${TEST_ISSUER}/oauth2/consent`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: TEST_CONFIGURATION.webOrigin,
            [TEST_SESSION_HEADER]: climber.sessionToken,
          },
          body: JSON.stringify(body),
        }),
      );
      const responseText = await response.text();
      return { response, body: (responseText ? JSON.parse(responseText) : {}) as OAuthResponseBody };
    },

    async close() {
      await Promise.all([primary.close(), secondary.close()]);
    },
  };

  return environment;
}

/**
 * Refuses every row write to `users` from connections tagged with the read-only
 * proof's application name, and only those. Other test files in the same worker
 * database keep working even if a run dies before this is dropped.
 */
export async function installReadOnlyUsersTrigger(): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION partner_oauth_refuse_users_write() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('application_name', true) = ${sql.raw(`'${READ_ONLY_PROOF_APPLICATION_NAME}'`)} THEN
        RAISE EXCEPTION 'partner authority wrote users' USING ERRCODE = 'P0001';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS partner_oauth_refuse_users_write_trigger ON users`);
  await db.execute(sql`
    CREATE TRIGGER partner_oauth_refuse_users_write_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION partner_oauth_refuse_users_write()
  `);
}

export async function dropReadOnlyUsersTrigger(): Promise<void> {
  await db.execute(sql`DROP TRIGGER IF EXISTS partner_oauth_refuse_users_write_trigger ON users`);
  await db.execute(sql`DROP FUNCTION IF EXISTS partner_oauth_refuse_users_write()`);
}
