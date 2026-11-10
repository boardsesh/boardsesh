import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  oauthAccessToken,
  oauthAppPolicy,
  oauthClient,
  oauthClientResource,
  oauthConnections,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshToken,
  oauthVerification,
  users,
} from '@boardsesh/db/schema/auth';
import { getWorkerDatabaseUrl } from '../../../__tests__/worker-db';
import { db } from '../../../db/client';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import { disconnectPartnerConnection } from '../connection';
import { createPartnerAuthorityRuntime, type PartnerAuthorityRuntime } from '../authority';
import { PARTNER_SCOPES } from '../configuration';
import { managedClientProblem } from '../registration';
import {
  PARTNER_APPS_PER_DEVELOPER,
  PARTNER_LAUNCH_MAX_ACTIVE_CONNECTIONS,
  PARTNER_LAUNCH_MAX_NEW_CONNECTIONS_PER_DAY,
  PARTNER_REDIRECT_URIS_PER_APP,
  PartnerRegistrationError,
  type PartnerAppCredentials,
} from '../registration-rules';
import type { PartnerDatabase } from '../tables';
import {
  createAuthorityDatabase,
  createPartnerTestEnvironment,
  TEST_CONFIGURATION,
  TEST_DEVELOPER_TERMS_VERSION,
  TEST_OAUTH_OPTIONS,
  TEST_RESOURCE,
  type PartnerTestEnvironment,
  type TestClimber,
  type TestClient,
} from './partner-fixture';

/** The GraphQL pool, which the console's operations run on. */
const consoleDatabase = db as unknown as PartnerDatabase;

const APP_INPUT = {
  name: 'Hangboard Planner',
  publisherName: 'Planner Labs',
  homepageUrl: 'https://planner.example.test/',
  privacyPolicyUrl: 'https://planner.example.test/privacy',
  applicationType: 'web',
  tokenEndpointAuthMethod: 'client_secret_post',
  redirectUris: ['https://planner.example.test/oauth/boardsesh'],
  acceptedTermsVersion: TEST_DEVELOPER_TERMS_VERSION,
};

const NATIVE_PUBLIC_INPUT = {
  name: 'Fingerboard CLI',
  publisherName: 'Ana Ruiz',
  homepageUrl: null,
  privacyPolicyUrl: 'https://cli.example.test/privacy',
  applicationType: 'native',
  tokenEndpointAuthMethod: 'none',
  redirectUris: ['http://127.0.0.1/callback', 'com.example.cli:/oauth/boardsesh'],
  acceptedTermsVersion: TEST_DEVELOPER_TERMS_VERSION,
};

async function refusal(promise: Promise<unknown>): Promise<PartnerRegistrationError> {
  const error = await promise.then(
    () => undefined,
    (rejected: unknown) => rejected,
  );
  if (!(error instanceof PartnerRegistrationError))
    throw new Error(`Expected a registration refusal, got ${String(error)}`);
  return error;
}

describe('partner app registration', () => {
  let environment: PartnerTestEnvironment;
  let runtime: PartnerAuthorityRuntime;
  let closeRuntimeDatabase: () => Promise<void>;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    const runtimeDatabase = createAuthorityDatabase('partner-registration-test');
    closeRuntimeDatabase = () => runtimeDatabase.close();
    runtime = await createPartnerAuthorityRuntime(runtimeDatabase.database, TEST_CONFIGURATION, {
      logbook: { feed: db, snapshots: db },
      close: () => runtimeDatabase.close(),
    });
  });

  afterAll(async () => {
    await environment?.close();
    await closeRuntimeDatabase?.();
  });

  async function createDeveloper({ verified = true }: { verified?: boolean } = {}): Promise<string> {
    const developerId = `developer-${randomUUID()}`;
    await db.insert(users).values({
      id: developerId,
      email: `${developerId}@example.invalid`,
      emailVerified: verified ? new Date() : null,
    });
    return developerId;
  }

  function register(developerId: string, input: Record<string, unknown> = APP_INPUT): Promise<PartnerAppCredentials> {
    return runtime.registration.createApp(consoleDatabase, developerId, input);
  }

  function testClient(credentials: PartnerAppCredentials, climber: TestClimber): TestClient {
    return {
      clientId: credentials.app.clientId,
      clientSecret: credentials.clientSecret ?? undefined,
      redirectUri: credentials.app.redirectUris[0],
      owner: climber,
    };
  }

  /** Authorize, approve consent, exchange: what a climber connecting a registered app goes through. */
  async function connect(client: TestClient) {
    const atConsent = await environment.authorize(client);
    expect(atConsent.location).toContain(TEST_OAUTH_OPTIONS.consentPage);
    const accepted = await environment.consent(client.owner, {
      accept: true,
      oauth_query: new URL(atConsent.location!).searchParams.toString(),
    });
    expect(accepted.response.status).toBe(200);
    return environment.exchange(client, { location: accepted.body.url!, verifier: atConsent.verifier });
  }

  /** The token endpoint authenticates the client before it looks at the token. */
  async function clientAuthenticates(client: TestClient): Promise<boolean> {
    const { body } = await environment.refresh(client, `unknown-${randomUUID()}`, environment.instance);
    if (body.error === 'invalid_grant') return true;
    if (body.error === 'invalid_client') return false;
    throw new Error(`Unexpected token response ${JSON.stringify(body)}`);
  }

  describe('the managed registration body', () => {
    it('fixes consent, PKCE, the auth method, scopes and the resource, and writes the launch caps', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, created.app.clientId));
      expect(row).toMatchObject({
        userId: developerId,
        skipConsent: false,
        requirePKCE: true,
        tokenEndpointAuthMethod: 'client_secret_post',
        jwks: null,
        jwksUri: null,
        disabled: false,
        applicationType: 'web',
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        scopes: PARTNER_SCOPES,
        clientCredentialsScopes: [],
        redirectUris: APP_INPUT.redirectUris,
        name: APP_INPUT.name,
        uri: APP_INPUT.homepageUrl,
        policy: APP_INPUT.privacyPolicyUrl,
      });
      expect(row.enableEndSession).not.toBe(true);
      expect(managedClientProblem(row, developerId)).toBeNull();

      const links = await db
        .select({ resourceId: oauthClientResource.resourceId })
        .from(oauthClientResource)
        .where(eq(oauthClientResource.clientId, created.app.clientId));
      expect(links).toEqual([{ resourceId: TEST_RESOURCE }]);

      const [policy] = await db.select().from(oauthAppPolicy).where(eq(oauthAppPolicy.clientId, created.app.clientId));
      expect(policy).toMatchObject({
        ownerUserId: developerId,
        publisherName: APP_INPUT.publisherName,
        maxActiveConnections: 25,
        maxNewConnectionsPerDay: 20,
        suspendedAt: null,
        termsVersion: TEST_DEVELOPER_TERMS_VERSION,
      });
      // Accepted during this registration, by the database row's own account.
      expect(policy.termsAcceptedAt).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - (policy.termsAcceptedAt as Date).getTime())).toBeLessThan(60_000);
      expect([PARTNER_LAUNCH_MAX_ACTIVE_CONNECTIONS, PARTNER_LAUNCH_MAX_NEW_CONNECTIONS_PER_DAY]).toEqual([25, 20]);
      expect(created.app).toMatchObject({
        publisherName: APP_INPUT.publisherName,
        maxActiveConnections: 25,
        maxNewConnectionsPerDay: 20,
      });
    });

    it('requires a publisher that does not pass as Boardsesh or a board maker, and writes nothing without one', async () => {
      const developerId = await createDeveloper();
      expect((await refusal(register(developerId, { ...APP_INPUT, publisherName: undefined }))).message).toMatch(
        /who makes the app/,
      );
      for (const publisherName of ['Boardsesh Team', 'Aurora Climbing', 'Moon Climbing', 'K1lter Grips']) {
        const refused = await refusal(register(developerId, { ...APP_INPUT, publisherName }));
        expect(refused.reason).toBe('invalid_input');
        expect(refused.message).toMatch(/publisher name cannot use or imitate/);
      }
      expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(0);
    });

    it('requires the current developer terms, and writes nothing without them', async () => {
      const developerId = await createDeveloper();
      for (const acceptedTermsVersion of [undefined, '2026-01-01']) {
        const refused = await refusal(register(developerId, { ...APP_INPUT, acceptedTermsVersion }));
        expect(refused.reason).toBe('invalid_input');
        expect(refused.message).toMatch(/Accept the current Boardsesh developer terms/);
      }
      expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(0);
    });

    it("registers nothing while the deployment's developer terms are a draft", async () => {
      const draftDatabase = createAuthorityDatabase('partner-registration-draft-terms');
      try {
        const draftRuntime = await createPartnerAuthorityRuntime(
          draftDatabase.database,
          { ...TEST_CONFIGURATION, developerTermsVersion: '2026-11-10-draft' },
          { logbook: { feed: db, snapshots: db }, close: () => draftDatabase.close() },
        );
        const developerId = await createDeveloper();
        const refused = await refusal(
          draftRuntime.registration.createApp(consoleDatabase, developerId, {
            ...APP_INPUT,
            acceptedTermsVersion: '2026-11-10-draft',
          }),
        );
        expect(refused.reason).toBe('terms_unpublished');
        expect(refused.message).toMatch(/^Developer terms are not published yet/);
        expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(0);
      } finally {
        await draftDatabase.close();
      }
    });

    it('ignores every hazard a caller slips into the input, and refuses private_key_jwt', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId, {
        ...APP_INPUT,
        skipConsent: true,
        skip_consent: true,
        requirePKCE: false,
        require_pkce: false,
        jwksUri: 'https://keys.example.test/jwks.json',
        jwks_uri: 'https://keys.example.test/jwks.json',
        scope: 'admin:everything',
      });
      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, created.app.clientId));
      expect(row).toMatchObject({ skipConsent: false, requirePKCE: true, jwksUri: null, scopes: PARTNER_SCOPES });

      for (const tokenEndpointAuthMethod of ['private_key_jwt', 'client_secret_jwt', 'tls_client_auth']) {
        const refused = await refusal(register(developerId, { ...APP_INPUT, tokenEndpointAuthMethod }));
        expect(refused.reason).toBe('invalid_input');
      }
      expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(1);
    });

    it('refuses, and rolls back, a stored client outside the managed policy', () => {
      const base = {
        id: 'row',
        clientId: 'client',
        clientSecret: '$ba$encrypted',
        clientDiscoveryId: null,
        disabled: false,
        skipConsent: false,
        enableEndSession: null,
        subjectType: null,
        scopes: PARTNER_SCOPES,
        clientCredentialsScopes: [],
        userId: 'developer',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'App',
        uri: null,
        icon: null,
        contacts: null,
        tos: null,
        policy: 'https://example.test/privacy',
        softwareId: null,
        softwareVersion: null,
        softwareStatement: null,
        redirectUris: ['https://example.test/cb'],
        postLogoutRedirectUris: null,
        backchannelLogoutUri: null,
        backchannelLogoutSessionRequired: null,
        tokenEndpointAuthMethod: 'client_secret_basic',
        applicationType: 'web',
        jwks: null,
        jwksUri: null,
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        requirePKCE: true,
        dpopBoundAccessTokens: false,
        referenceId: null,
        metadata: null,
      } satisfies typeof oauthClient.$inferSelect;
      expect(managedClientProblem(base, 'developer')).toBeNull();
      expect(managedClientProblem({ ...base, skipConsent: true }, 'developer')).toBe('skip_consent');
      expect(managedClientProblem({ ...base, skipConsent: null }, 'developer')).toBe('skip_consent');
      expect(managedClientProblem({ ...base, requirePKCE: false }, 'developer')).toBe('require_pkce');
      expect(managedClientProblem({ ...base, requirePKCE: null }, 'developer')).toBe('require_pkce');
      expect(managedClientProblem({ ...base, tokenEndpointAuthMethod: 'private_key_jwt' }, 'developer')).toBe(
        'token_endpoint_auth_method',
      );
      expect(managedClientProblem({ ...base, jwksUri: 'https://keys.example.test' }, 'developer')).toBe('jwks');
      expect(managedClientProblem({ ...base, userId: 'someone-else' }, 'developer')).toBe('owner');
      expect(managedClientProblem({ ...base, grantTypes: ['client_credentials'] }, 'developer')).toBe('grant_types');
      expect(managedClientProblem({ ...base, clientCredentialsScopes: ['profile:read'] }, 'developer')).toBe(
        'client_credentials_scopes',
      );
      expect(managedClientProblem({ ...base, tokenEndpointAuthMethod: 'none' }, 'developer')).toBe('client_secret');
      expect(managedClientProblem({ ...base, clientSecret: null }, 'developer')).toBe('client_secret');
    });
  });

  describe('client secrets', () => {
    it('are made by the server, shown once, stored encrypted with the authority secret, and authenticate', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      const secret = created.clientSecret;
      expect(secret).toMatch(/^[A-Za-z]{32}$/);

      const [row] = await db
        .select({ clientSecret: oauthClient.clientSecret })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, created.app.clientId));
      // Better Auth's versioned envelope from PARTNER_OAUTH_SECRETS, not the secret and not a bare hash.
      expect(row.clientSecret).toMatch(/^\$ba\$1\$/);
      expect(row.clientSecret).not.toContain(secret);
      expect(row.clientSecret).not.toBe(createHash('sha256').update(secret!).digest('base64url'));

      // Never readable again: the record and the list carry no secret at all.
      expect(Object.keys(created.app)).not.toContain('clientSecret');
      const listed = await runtime.registration.listApps(consoleDatabase, developerId);
      expect(listed).toEqual([created.app]);
      expect(JSON.stringify(listed)).not.toContain(secret);

      // A second authority with the same PARTNER_OAUTH_SECRETS verifies it.
      const climber = await environment.createClimber();
      expect(await clientAuthenticates(testClient(created, climber))).toBe(true);
      expect(await clientAuthenticates({ ...testClient(created, climber), clientSecret: `${secret}x` })).toBe(false);
    });

    it('rotates immediately: the old secret stops working and the new one works', async () => {
      const developerId = await createDeveloper();
      const climber = await environment.createClimber();
      const created = await register(developerId);
      const issued = await connect(testClient(created, climber));
      expect(issued.response.status).toBe(200);

      const rotated = await runtime.registration.rotateSecret(consoleDatabase, developerId, created.app.clientId);
      expect(rotated.clientSecret).toMatch(/^[A-Za-z]{32}$/);
      expect(rotated.clientSecret).not.toBe(created.clientSecret);
      // The same app, now with the climber who connected since it was registered.
      expect(rotated.app).toEqual({ ...created.app, activeConnections: 1 });

      const oldClient = testClient(created, climber);
      const newClient = testClient(rotated, climber);
      expect(await clientAuthenticates(oldClient)).toBe(false);
      expect((await environment.refresh(oldClient, issued.body.refresh_token!)).body.error).toBe('invalid_client');
      expect(await clientAuthenticates(newClient)).toBe(true);
      expect((await environment.refresh(newClient, issued.body.refresh_token!)).response.status).toBe(200);
    });

    it('a public app gets none, and has nothing to rotate', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId, NATIVE_PUBLIC_INPUT);
      expect(created.clientSecret).toBeNull();
      expect(created.app).toMatchObject({
        applicationType: 'native',
        tokenEndpointAuthMethod: 'none',
        homepageUrl: null,
      });
      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, created.app.clientId));
      expect(row.clientSecret).toBeNull();
      expect(
        (await refusal(runtime.registration.rotateSecret(consoleDatabase, developerId, created.app.clientId))).reason,
      ).toBe('no_secret');
    });
  });

  describe('a registered app in the OAuth flow', () => {
    it('always shows consent, then issues and refreshes tokens', async () => {
      const developerId = await createDeveloper();
      const climber = await environment.createClimber();
      const client = testClient(await register(developerId), climber);
      const issued = await connect(client);
      expect(issued.response.status).toBe(200);
      expect(issued.body.scope).toBe('profile:read offline_access');
      expect((await environment.refresh(client, issued.body.refresh_token!)).response.status).toBe(200);
    });

    it('requires PKCE even from a confidential app', async () => {
      const developerId = await createDeveloper();
      const climber = await environment.createClimber();
      const client = testClient(await register(developerId), climber);
      const withoutChallenge = await environment.authorize(client, { omitChallenge: true });
      expect(withoutChallenge.location).not.toContain('code=');
      expect(withoutChallenge.location).not.toContain(TEST_OAUTH_OPTIONS.consentPage);
    });

    it('lets a native public app redirect to any loopback port it registered without one', async () => {
      const developerId = await createDeveloper();
      const climber = await environment.createClimber();
      const created = await register(developerId, NATIVE_PUBLIC_INPUT);
      const client = { ...testClient(created, climber), redirectUri: 'http://127.0.0.1:53117/callback' };
      const atConsent = await environment.authorize(client);
      expect(atConsent.location).toContain(TEST_OAUTH_OPTIONS.consentPage);
      const elsewhere = await environment.authorize({ ...client, redirectUri: 'http://127.0.0.1:53117/other' });
      expect(elsewhere.location).not.toContain(TEST_OAUTH_OPTIONS.consentPage);
    });

    it('makes a new web origin eligible for CORS at once', async () => {
      const developerId = await createDeveloper();
      const origin = `https://${randomUUID()}.example.test`;
      expect(await runtime.registeredOrigins.isRegisteredOrigin(origin)).toBe(false);
      await register(developerId, { ...APP_INPUT, redirectUris: [`${origin}/callback`] });
      expect(await runtime.registeredOrigins.isRegisteredOrigin(origin)).toBe(true);
    });
  });

  describe('caps', () => {
    it(`refuses app ${PARTNER_APPS_PER_DEVELOPER + 1} for one developer`, async () => {
      const developerId = await createDeveloper();
      for (let index = 0; index < PARTNER_APPS_PER_DEVELOPER; index += 1) {
        await register(developerId, { ...APP_INPUT, name: `Planner number ${index}` });
      }
      expect((await refusal(register(developerId))).reason).toBe('app_limit_reached');
      expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(PARTNER_APPS_PER_DEVELOPER);
      // Another developer is unaffected.
      expect((await register(await createDeveloper())).app.clientId).toBeTruthy();
    });

    it(`holds ${PARTNER_APPS_PER_DEVELOPER} apps when registrations race`, async () => {
      const developerId = await createDeveloper();
      const attempts = await Promise.allSettled(
        Array.from({ length: PARTNER_APPS_PER_DEVELOPER + 2 }, (_, index) =>
          register(developerId, { ...APP_INPUT, name: `Racing planner ${index}` }),
        ),
      );
      const refusals = attempts.flatMap((attempt) =>
        attempt.status === 'rejected' && attempt.reason instanceof PartnerRegistrationError
          ? [attempt.reason.reason]
          : [],
      );
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(PARTNER_APPS_PER_DEVELOPER);
      expect(refusals).toEqual(['app_limit_reached', 'app_limit_reached']);
      expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(PARTNER_APPS_PER_DEVELOPER);
      expect(await db.$count(oauthAppPolicy, eq(oauthAppPolicy.ownerUserId, developerId))).toBe(
        PARTNER_APPS_PER_DEVELOPER,
      );
    });

    it(`refuses more than ${PARTNER_REDIRECT_URIS_PER_APP} redirect URIs`, async () => {
      const developerId = await createDeveloper();
      const redirectUris = Array.from(
        { length: PARTNER_REDIRECT_URIS_PER_APP + 1 },
        (_, index) => `https://planner.example.test/cb/${index}`,
      );
      expect((await refusal(register(developerId, { ...APP_INPUT, redirectUris }))).reason).toBe('invalid_input');
      expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(0);
    });
  });

  describe('the developer', () => {
    it('must have a verified email', async () => {
      const developerId = await createDeveloper({ verified: false });
      expect((await refusal(register(developerId))).reason).toBe('email_not_verified');
      expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(0);
    });

    it('sees and changes only their own apps', async () => {
      const ownerId = await createDeveloper();
      const strangerId = await createDeveloper();
      const created = await register(ownerId);
      const { clientId } = created.app;

      expect(await runtime.registration.listApps(consoleDatabase, strangerId)).toEqual([]);
      expect(
        (await refusal(runtime.registration.updateApp(consoleDatabase, strangerId, clientId, { name: 'Taken over' })))
          .reason,
      ).toBe('not_found');
      expect((await refusal(runtime.registration.rotateSecret(consoleDatabase, strangerId, clientId))).reason).toBe(
        'not_found',
      );
      expect(await runtime.registration.deleteApp(consoleDatabase, strangerId, clientId)).toBe(false);

      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
      expect(row.name).toBe(APP_INPUT.name);
      const climber = await environment.createClimber();
      expect(await clientAuthenticates(testClient(created, climber))).toBe(true);
    });
  });

  describe('editing', () => {
    it('changes the publisher on the policy row, and never clears it', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      const { clientId } = created.app;
      const renamed = await runtime.registration.updateApp(consoleDatabase, developerId, clientId, {
        publisherName: '  Planner   Labs Ltd ',
      });
      expect(renamed).toMatchObject({ publisherName: 'Planner Labs Ltd', name: APP_INPUT.name });
      const [policy] = await db.select().from(oauthAppPolicy).where(eq(oauthAppPolicy.clientId, clientId));
      expect(policy.publisherName).toBe('Planner Labs Ltd');

      for (const publisherName of ['Boardsesh', '', 'x']) {
        const refused = await refusal(
          runtime.registration.updateApp(consoleDatabase, developerId, clientId, { publisherName }),
        );
        expect(refused.reason).toBe('invalid_input');
      }
      // A null publisher means "keep it": with nothing else, there is nothing to change.
      expect(
        (await refusal(runtime.registration.updateApp(consoleDatabase, developerId, clientId, { publisherName: null })))
          .reason,
      ).toBe('invalid_input');
      const [listed] = await runtime.registration.listApps(consoleDatabase, developerId);
      expect(listed.publisherName).toBe('Planner Labs Ltd');
    });

    it('changes the developer fields and nothing the policy fixes', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      const updated = await runtime.registration.updateApp(consoleDatabase, developerId, created.app.clientId, {
        name: 'Hangboard Planner 2',
        homepageUrl: null,
        redirectUris: ['https://planner.example.test/oauth/v2'],
      });
      expect(updated).toMatchObject({
        name: 'Hangboard Planner 2',
        homepageUrl: null,
        privacyPolicyUrl: APP_INPUT.privacyPolicyUrl,
        redirectUris: ['https://planner.example.test/oauth/v2'],
      });
      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, created.app.clientId));
      expect(row).toMatchObject({
        skipConsent: false,
        requirePKCE: true,
        tokenEndpointAuthMethod: 'client_secret_post',
      });
    });

    it('holds an edit to the same redirect rules, for the app type it was registered with', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      for (const redirectUris of [
        ['http://127.0.0.1/callback'],
        ['com.example.app:/cb'],
        ['https://www.boardsesh.com/cb'],
      ]) {
        const refused = await refusal(
          runtime.registration.updateApp(consoleDatabase, developerId, created.app.clientId, { redirectUris }),
        );
        expect(refused.reason).toBe('invalid_input');
      }
      expect(
        (await refusal(runtime.registration.updateApp(consoleDatabase, developerId, created.app.clientId, {}))).reason,
      ).toBe('invalid_input');
    });
  });

  describe('a suspended app', () => {
    it('cannot be edited, rotated or deleted by its developer', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      const { clientId } = created.app;
      await db.update(oauthClient).set({ disabled: true }).where(eq(oauthClient.clientId, clientId));
      await db
        .update(oauthAppPolicy)
        .set({ suspendedAt: new Date(), suspensionReason: 'Phishing reports' })
        .where(eq(oauthAppPolicy.clientId, clientId));

      expect(
        (await refusal(runtime.registration.updateApp(consoleDatabase, developerId, clientId, { name: 'Clean' })))
          .reason,
      ).toBe('suspended');
      expect((await refusal(runtime.registration.rotateSecret(consoleDatabase, developerId, clientId))).reason).toBe(
        'suspended',
      );
      expect((await refusal(runtime.registration.deleteApp(consoleDatabase, developerId, clientId))).reason).toBe(
        'suspended',
      );
      const [listed] = await runtime.registration.listApps(consoleDatabase, developerId);
      expect(listed).toMatchObject({ clientId, suspensionReason: 'Phishing reports' });
      expect(listed.suspendedAt).toBeInstanceOf(Date);
    });
  });

  describe('deleting', () => {
    it('ends every connection, token and pending code of that app only', async () => {
      const developerId = await createDeveloper();
      const climber = await environment.createClimber();
      const doomed = testClient(await register(developerId), climber);
      const kept = testClient(await register(developerId, { ...APP_INPUT, name: 'Campus Board Log' }), climber);
      const doomedTokens = await connect(doomed);
      const keptTokens = await connect(kept);
      expect([doomedTokens.response.status, keptTokens.response.status]).toEqual([200, 200]);
      // A code issued and never redeemed: oauth_verification has no foreign key to
      // cascade from. Consent is remembered now, so the code comes straight back.
      const pending = await environment.authorize(doomed);
      const pendingCode = new URL(pending.location!).searchParams.get('code');
      const [connection] = await db
        .select({ id: oauthConnections.id })
        .from(oauthConnections)
        .where(eq(oauthConnections.clientId, doomed.clientId));
      const grantIds = (await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id))).map(
        (grant) => grant.authorizationCodeId,
      );
      expect(await db.$count(oauthVerification, eq(oauthVerification.identifier, grantIds.at(-1)!))).toBe(1);

      expect(await runtime.registration.deleteApp(consoleDatabase, developerId, doomed.clientId)).toBe(true);

      expect(await db.$count(oauthClient, eq(oauthClient.clientId, doomed.clientId))).toBe(0);
      expect(await db.$count(oauthAppPolicy, eq(oauthAppPolicy.clientId, doomed.clientId))).toBe(0);
      expect(await db.$count(oauthConnections, eq(oauthConnections.clientId, doomed.clientId))).toBe(0);
      expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.clientId, doomed.clientId))).toBe(0);
      expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.clientId, doomed.clientId))).toBe(0);
      for (const grantId of grantIds) {
        expect(await db.$count(oauthVerification, eq(oauthVerification.identifier, grantId))).toBe(0);
      }
      expect(pendingCode).toBeTruthy();

      expect((await environment.refresh(kept, keptTokens.body.refresh_token!)).response.status).toBe(200);
      expect(await runtime.registration.deleteApp(consoleDatabase, developerId, doomed.clientId)).toBe(false);
    });
  });

  describe('the connection count', () => {
    it('counts the climbers connected now, the way the caps count them', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      expect(created.app.activeConnections).toBe(0);
      const climber = await environment.createClimber();
      expect((await connect(testClient(created, climber))).response.status).toBe(200);
      // An approval nobody redeemed is not a connection.
      await environment.authorize(testClient(created, await environment.createClimber()));

      const [listed] = await runtime.registration.listApps(consoleDatabase, developerId);
      expect(listed.activeConnections).toBe(1);
      expect(
        (await runtime.registration.updateApp(consoleDatabase, developerId, created.app.clientId, { name: 'Renamed' }))
          .activeConnections,
      ).toBe(1);

      await disconnectPartnerConnection(consoleDatabase, {
        userId: climber.userId,
        clientId: created.app.clientId,
        reason: 'climber_disconnect',
      });
      expect((await runtime.registration.listApps(consoleDatabase, developerId))[0].activeConnections).toBe(0);
    });
  });

  describe('deleting, in the partner lock order', () => {
    let raw: ReturnType<typeof postgres>;

    beforeAll(() => {
      raw = postgres(getWorkerDatabaseUrl(), { max: 4, onnotice: () => {} });
    });

    afterAll(async () => {
      await raw?.end({ timeout: 5 });
    });

    /** A barrier on what the database says, never on a clock. */
    async function waitForLockWaiters(minimum: number): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [row] = await raw<Array<{ waiting: number }>>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (row.waiting >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Fewer than ${minimum} sessions ever waited on a lock`);
    }

    it('makes a password reset racing an app delete wait for it, instead of deadlocking', async () => {
      // The reset trigger takes the climber's users row, then their connections
      // and consent screens. The delete takes users FOR SHARE before any of
      // those, so the two queue in one order instead of crossing.
      const developerId = await createDeveloper();
      const created = await register(developerId);
      const { clientId } = created.app;
      expect((await connect(testClient(created, await environment.createClimber()))).response.status).toBe(200);
      expect((await connect(testClient(created, await environment.createClimber()))).response.status).toBe(200);
      const rows = await db
        .select({ id: oauthConnections.id, userId: oauthConnections.userId })
        .from(oauthConnections)
        .where(eq(oauthConnections.clientId, clientId));
      rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      // The delete locks connections in id order, so it parks on the first.
      const [held, target] = rows;
      await db.insert(oauthConsentInteractions).values({
        digest: `digest-${randomUUID()}`,
        userId: target.userId,
        authSessionId: `session-${randomUUID()}`,
        clientId,
        connectionGeneration: 1,
        expiresAt: new Date(Date.now() + 600_000),
      });

      const issuer = await raw.reserve();
      const reset = await raw.reserve();
      try {
        await issuer`BEGIN`;
        await issuer`SELECT 1 FROM oauth_connections WHERE id = ${held.id} FOR UPDATE`;
        const deleting = runtime.registration.deleteApp(consoleDatabase, developerId, clientId);
        await waitForLockWaiters(1);
        await reset`BEGIN`;
        const resetting = reset`
          INSERT INTO user_credentials (user_id, password_hash) VALUES (${target.userId}, 'hash')
          ON CONFLICT (user_id) DO UPDATE SET password_hash = 'hash-' || now()::text`.then(
          () => 'written',
          (error: unknown) => getPostgresErrorCode(error),
        );
        await waitForLockWaiters(2);
        await issuer`ROLLBACK`;
        expect(await deleting).toBe(true);
        expect(await resetting).toBe('written');
        await reset`COMMIT`;
      } finally {
        await issuer`ROLLBACK`.catch(() => undefined);
        await reset`ROLLBACK`.catch(() => undefined);
        issuer.release();
        reset.release();
      }
    });

    it('gives way as busy, never deadlocking, to a consent answer holding a screen opened mid-delete', async () => {
      const developerId = await createDeveloper();
      const climber = await environment.createClimber();
      const created = await register(developerId);
      expect((await connect(testClient(created, climber))).response.status).toBe(200);
      const { clientId } = created.app;
      const [connection] = await db
        .select({ id: oauthConnections.id })
        .from(oauthConnections)
        .where(eq(oauthConnections.clientId, clientId));

      const issuer = await raw.reserve();
      const answer = await raw.reserve();
      try {
        // An issuer holds the connection: the delete takes its climber and
        // screen locks, then queues on the connection.
        await issuer`BEGIN`;
        await issuer`SELECT 1 FROM oauth_connections WHERE id = ${connection.id} FOR UPDATE`;
        const deleting = runtime.registration.deleteApp(consoleDatabase, developerId, clientId).then(
          (deleted) => deleted,
          (error: unknown) => error,
        );
        await waitForLockWaiters(1);

        // A consent screen opened after the delete's first pass, and an answer
        // in consent's own order: the screen, then the connection.
        const digest = `digest-${randomUUID()}`;
        await db.insert(oauthConsentInteractions).values({
          digest,
          userId: climber.userId,
          authSessionId: `session-${randomUUID()}`,
          clientId,
          connectionGeneration: 0,
          expiresAt: new Date(Date.now() + 600_000),
        });
        await answer`BEGIN`;
        await answer`SELECT 1 FROM oauth_consent_interactions WHERE digest = ${digest} FOR UPDATE`;
        const answering = answer`SELECT 1 FROM oauth_connections WHERE id = ${connection.id} FOR UPDATE`.then(
          () => 'locked',
          (error: unknown) => error,
        );
        await waitForLockWaiters(2);

        await issuer`ROLLBACK`;
        const outcome = await deleting;
        // The delete refused to wait on the held screen (NOWAIT), so there was
        // no cycle for Postgres to break by aborting the climber's answer.
        expect(outcome).toBeInstanceOf(PartnerRegistrationError);
        expect((outcome as PartnerRegistrationError).reason).toBe('busy');
        expect(getPostgresErrorCode((outcome as PartnerRegistrationError).cause)).toBe('55P03');
        expect(await answering).toBe('locked');
        await answer`COMMIT`;
      } finally {
        await issuer`ROLLBACK`.catch(() => undefined);
        await answer`ROLLBACK`.catch(() => undefined);
        issuer.release();
        answer.release();
      }

      expect(await db.$count(oauthClient, eq(oauthClient.clientId, clientId))).toBe(1);
      // The developer's retry goes through, and takes the screen with the app.
      expect(await runtime.registration.deleteApp(consoleDatabase, developerId, clientId)).toBe(true);
      expect(await db.$count(oauthConsentInteractions, eq(oauthConsentInteractions.clientId, clientId))).toBe(0);
    });
  });

  describe('the registration actor', () => {
    it('gives a provider client call no developer outside registration', async () => {
      const developerId = await createDeveloper();
      const created = await register(developerId);
      await expect(
        runtime.authority.api.rotateClientSecret({
          headers: new Headers(),
          body: { client_id: created.app.clientId },
        }),
      ).rejects.toThrow();
      const response = await runtime.handleRequest(
        new Request(`${TEST_CONFIGURATION.issuer}/oauth2/client/rotate-secret`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: TEST_CONFIGURATION.webOrigin },
          body: JSON.stringify({ client_id: created.app.clientId }),
        }),
      );
      expect(response.status).toBe(404);
      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, created.app.clientId));
      const climber = await environment.createClimber();
      expect(row.clientSecret).toBeTruthy();
      expect(await clientAuthenticates(testClient(created, climber))).toBe(true);
    });
  });
});
