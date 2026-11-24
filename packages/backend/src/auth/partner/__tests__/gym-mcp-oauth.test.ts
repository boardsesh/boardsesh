import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  gymMcpWriteReceipts,
  oauthAccessToken,
  oauthRefreshToken,
  oauthAppPolicy,
  oauthClient,
  oauthClientResource,
  oauthMcpClientPolicy,
} from '@boardsesh/db/schema/auth';
import { communityRoles } from '@boardsesh/db/schema';
import { db, deferDatabaseEffect } from '../../../db/client';
import { createPartnerAuthorityRuntime, type PartnerAuthorityRuntime } from '../authority';
import { createGymMcpClientDiscovery } from '../gym-mcp-clients';
import { createPartnerDatabaseHandle } from '../transaction';
import { disconnectPartnerConnection } from '../connection';
import * as runtimeLoader from '../load-authority';
import * as connectionLocks from '../locks';
import { sweepGymMcpReceiptPayloads } from '../../../services/gym-mcp-receipt-retention';
import { withGymMcpWrite } from '../../../mcp/gyms/auth';
import {
  createPartnerTestEnvironment,
  testSessionBridge,
  TEST_CONFIGURATION,
  TEST_RESOURCE,
  TEST_SESSION_HEADER,
  type PartnerTestEnvironment,
  type TestClient,
} from './partner-fixture';
import {
  GYM_MCP_RESOURCE,
  GYM_MCP_SCOPES,
  GYM_MCP_DEFAULT_SCOPES,
  GYM_MCP_ADMIN_SCOPES,
} from '../../../mcp/gyms/configuration';

const CLIENT_ID = 'https://assistant.example/oauth/gym-client.json';
const REDIRECT_URI = 'https://assistant.example/callback';

describe('hosted gym OAuth boundaries', () => {
  let environment: PartnerTestEnvironment;
  let runtime: PartnerAuthorityRuntime;
  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    const clients = createGymMcpClientDiscovery(environment.database, {
      fetchMetadata: async () =>
        Response.json({
          client_id: CLIENT_ID,
          client_name: 'Gym assistant',
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
    });
    runtime = await createPartnerAuthorityRuntime(
      environment.database,
      {
        ...TEST_CONFIGURATION,
        gymMcp: { mode: 'on', pilotUserIds: [] },
      },
      {
        close: async () => {},
        logbook: { feed: db, snapshots: db },
        gymMcpClients: clients,
        plugins: [testSessionBridge(createPartnerDatabaseHandle(environment.database))],
      },
    );
  });
  afterAll(async () => {
    await environment?.close();
  });
  const target = { handler: (request: Request) => runtime.handleRequest(request) };

  async function issueGymTokens() {
    const owner = await environment.createClimber();
    const client: TestClient = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, owner, answersConsentScreen: true };
    const authorization = await environment.authorize(
      client,
      { resource: GYM_MCP_RESOURCE, scopes: [...GYM_MCP_DEFAULT_SCOPES] },
      target,
    );
    const issued = await environment.exchange(client, authorization, target, { resource: GYM_MCP_RESOURCE });
    expect(issued.response.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.access_token).toEqual(expect.any(String));
    return { client, issued: issued.body, owner };
  }

  it('discovers public clients with server-owned policy and only the gym audience', async () => {
    const { issued } = await issueGymTokens();
    const [client] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, CLIENT_ID));
    expect(client.userId).toBeNull();
    expect(client.clientDiscoveryId).toBe('cimd');
    expect(client.scopes?.sort()).toEqual([...GYM_MCP_SCOPES].sort());
    expect(client.tokenEndpointAuthMethod).toBe('none');
    expect(client.requirePKCE).toBe(true);
    const links = await db.select().from(oauthClientResource).where(eq(oauthClientResource.clientId, CLIENT_ID));
    expect(links.map((link) => link.resourceId)).toEqual([GYM_MCP_RESOURCE]);
    expect(
      await db.select().from(oauthMcpClientPolicy).where(eq(oauthMcpClientPolicy.clientId, CLIENT_ID)),
    ).toHaveLength(1);
    expect(await db.select().from(oauthAppPolicy).where(eq(oauthAppPolicy.clientId, CLIENT_ID))).toHaveLength(0);
    expect((await runtime.gymMcpApi!.authenticate(issued.access_token!)).principal).toBeDefined();
    expect((await runtime.api.authenticate(issued.access_token!)).refusal).toBe('wrong_audience');
  });

  it('does not fetch or persist an untrusted pilot client before browser sign-in', async () => {
    const untrustedClientId = `https://untrusted.example/${randomUUID()}/client.json`;
    const fetchMetadata = vi.fn();
    const pilotConfiguration = { ...TEST_CONFIGURATION, gymMcp: { mode: 'pilot' as const, pilotUserIds: [] } };
    const pilotClients = createGymMcpClientDiscovery(environment.database, {
      configuration: pilotConfiguration.gymMcp,
      fetchMetadata,
    });
    const pilotRuntime = await createPartnerAuthorityRuntime(environment.database, pilotConfiguration, {
      close: async () => {},
      logbook: { feed: db, snapshots: db },
      gymMcpClients: pilotClients,
      plugins: [testSessionBridge(createPartnerDatabaseHandle(environment.database))],
    });
    const query = new URLSearchParams({
      client_id: untrustedClientId,
      redirect_uri: 'https://untrusted.example/callback',
      response_type: 'code',
      scope: 'gyms:read',
      resource: GYM_MCP_RESOURCE,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });
    const response = await pilotRuntime.handleRequest(
      new Request(`${TEST_CONFIGURATION.issuer}/oauth2/authorize?${query}`),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(await db.select().from(oauthClient).where(eq(oauthClient.clientId, untrustedClientId))).toHaveLength(0);
    expect(
      await db.select().from(oauthMcpClientPolicy).where(eq(oauthMcpClientPolicy.clientId, untrustedClientId)),
    ).toHaveLength(0);
  });

  it('requires explicit global-admin consent and refuses board-scoped admins', async () => {
    for (const boardType of [undefined, 'moonboard']) {
      const owner = await environment.createClimber();
      if (boardType) await db.insert(communityRoles).values({ userId: owner.userId, role: 'admin', boardType });
      const client: TestClient = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, owner, answersConsentScreen: true };
      const authorization = await environment.authorize(
        client,
        { resource: GYM_MCP_RESOURCE, scopes: [...GYM_MCP_ADMIN_SCOPES] },
        target,
      );
      expect(authorization.response.status).toBe(403);
      expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, owner.userId))).toHaveLength(0);
    }
  });

  it('steps an existing CIMD identity up only through new consent, leaving old tokens unchanged', async () => {
    const ordinary = await issueGymTokens();
    await db
      .update(oauthClient)
      .set({ scopes: [...GYM_MCP_DEFAULT_SCOPES] })
      .where(eq(oauthClient.clientId, CLIENT_ID));
    const owner = await environment.createClimber();
    await db.insert(communityRoles).values({ userId: owner.userId, role: 'admin', boardType: null });
    const client: TestClient = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, owner, answersConsentScreen: true };
    const authorization = await environment.authorize(
      client,
      { resource: GYM_MCP_RESOURCE, scopes: [...GYM_MCP_DEFAULT_SCOPES, ...GYM_MCP_ADMIN_SCOPES] },
      target,
    );
    const issued = await environment.exchange(client, authorization, target, { resource: GYM_MCP_RESOURCE });
    expect(issued.response.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.scope?.split(' ')).toEqual(expect.arrayContaining([...GYM_MCP_ADMIN_SCOPES]));
    expect((await runtime.gymMcpApi!.authenticate(ordinary.issued.access_token!)).principal?.scopes).not.toEqual(
      expect.arrayContaining([...GYM_MCP_ADMIN_SCOPES]),
    );
  });

  it.each([undefined, ''])('keeps omitted or empty scopes ordinary even for a global admin: %s', async (scope) => {
    const owner = await environment.createClimber();
    await db.insert(communityRoles).values({ userId: owner.userId, role: 'admin', boardType: null });
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      resource: GYM_MCP_RESOURCE,
      state: randomUUID(),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    if (scope !== undefined) query.set('scope', scope);
    const response = await target.handler(
      new Request(`${TEST_CONFIGURATION.issuer}/oauth2/authorize?${query}`, {
        headers: { [TEST_SESSION_HEADER]: owner.sessionToken },
      }),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(new URL(location).searchParams.get('scope')?.split(' ')).toEqual([...GYM_MCP_DEFAULT_SCOPES]);
  });

  it('rolls back token issuance after global admin is revoked between consent and exchange', async () => {
    const owner = await environment.createClimber();
    await db.insert(communityRoles).values({ userId: owner.userId, role: 'admin', boardType: null });
    const client: TestClient = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, owner, answersConsentScreen: true };
    const authorization = await environment.authorize(
      client,
      { resource: GYM_MCP_RESOURCE, scopes: [...GYM_MCP_DEFAULT_SCOPES, ...GYM_MCP_ADMIN_SCOPES] },
      target,
    );
    await db.delete(communityRoles).where(eq(communityRoles.userId, owner.userId));
    const issued = await environment.exchange(client, authorization, target, { resource: GYM_MCP_RESOURCE });
    expect(issued.response.status).toBe(403);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, owner.userId))).toHaveLength(0);
    expect(await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, owner.userId))).toHaveLength(0);
  });

  it('rolls back revoked admin refreshes but permits explicit downscoping to ordinary access', async () => {
    const owner = await environment.createClimber();
    await db.insert(communityRoles).values({ userId: owner.userId, role: 'admin', boardType: null });
    const client: TestClient = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, owner, answersConsentScreen: true };
    const authorization = await environment.authorize(
      client,
      { resource: GYM_MCP_RESOURCE, scopes: [...GYM_MCP_DEFAULT_SCOPES, ...GYM_MCP_ADMIN_SCOPES] },
      target,
    );
    const issued = await environment.exchange(client, authorization, target, { resource: GYM_MCP_RESOURCE });
    expect(issued.response.status, JSON.stringify(issued.body)).toBe(200);
    const accessBefore = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, owner.userId));
    const refreshBefore = await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, owner.userId));
    await db.delete(communityRoles).where(eq(communityRoles.userId, owner.userId));
    const refused = await environment.refresh(client, issued.body.refresh_token!, target);
    expect(refused.response.status, JSON.stringify(refused.body)).toBe(403);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, owner.userId))).toEqual(
      accessBefore,
    );
    expect(await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, owner.userId))).toEqual(
      refreshBefore,
    );
    const downscoped = await environment.refresh(
      client,
      issued.body.refresh_token!,
      target,
      GYM_MCP_DEFAULT_SCOPES.join(' '),
    );
    expect(downscoped.response.status, JSON.stringify(downscoped.body)).toBe(200);
    expect(downscoped.body.scope?.split(' ')).not.toEqual(expect.arrayContaining([...GYM_MCP_ADMIN_SCOPES]));
  });

  it('leaves managed training registrations and their token audience unchanged', async () => {
    const owner = await environment.createClimber();
    const registration = await runtime.authority.api.adminCreateOAuthClient({
      headers: new Headers({ [TEST_SESSION_HEADER]: owner.sessionToken }),
      body: {
        client_name: 'Training app',
        redirect_uris: [`https://training.example/callback/${randomUUID()}`],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile:read logbook:read offline_access',
        resources: [TEST_RESOURCE],
        require_pkce: true,
      },
    });
    const [client] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, registration.client_id));
    expect(client.scopes).toEqual(['profile:read', 'logbook:read', 'offline_access']);
    const links = await db
      .select()
      .from(oauthClientResource)
      .where(eq(oauthClientResource.clientId, registration.client_id));
    expect(links.map((link) => link.resourceId)).toEqual([TEST_RESOURCE]);
    const trainingClient = await environment.createClient({ publicClient: true });
    const trainingTokens = await environment.issueTokens(trainingClient);
    expect((await runtime.gymMcpApi!.authenticate(trainingTokens.access_token)).refusal).toBe('wrong_audience');
  });

  it('refuses a gym client asking for training scopes or another resource', async () => {
    const owner = await environment.createClimber();
    const client: TestClient = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, owner };
    const wrongScope = await environment.authorize(
      client,
      { resource: GYM_MCP_RESOURCE, scopes: ['logbook:read'] },
      target,
    );
    expect(wrongScope.response.status).toBe(403);
    const wrongAudience = await environment.authorize(
      client,
      { resource: TEST_RESOURCE, scopes: ['gyms:read'] },
      target,
    );
    expect(wrongAudience.response.status).toBe(403);
  });

  it('shows the verified client hostname on consent and refuses users outside the pilot', async () => {
    const owner = await environment.createClimber();
    const client: TestClient = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, owner };
    const authorization = await environment.authorize(
      client,
      { resource: GYM_MCP_RESOURCE, scopes: [...GYM_MCP_DEFAULT_SCOPES] },
      target,
    );
    expect(authorization.location).toEqual(expect.stringContaining('/oauth/consent?'));
    const detailsResponse = await runtime.handleRequest(
      new Request(`${TEST_CONFIGURATION.issuer}/oauth2/consent-details`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: TEST_CONFIGURATION.webOrigin,
          [TEST_SESSION_HEADER]: owner.sessionToken,
        },
        body: JSON.stringify({ oauth_query: new URL(authorization.location!).searchParams.toString() }),
      }),
    );
    expect(detailsResponse.status).toBe(200);
    const details: unknown = await detailsResponse.json();
    expect(details).toEqual(
      expect.objectContaining({
        client: expect.objectContaining({
          identifierHost: 'assistant.example',
          serverManaged: true,
          publisherName: null,
        }),
      }),
    );
    const pilotConfiguration = {
      ...TEST_CONFIGURATION,
      gymMcp: { mode: 'pilot' as const, pilotUserIds: [], pilotClientOrigins: ['https://assistant.example'] },
    };
    const pilotClients = createGymMcpClientDiscovery(environment.database, {
      configuration: pilotConfiguration.gymMcp,
      fetchMetadata: async () =>
        Response.json({ client_id: CLIENT_ID, client_name: 'Gym assistant', redirect_uris: [REDIRECT_URI] }),
    });
    const pilotRuntime = await createPartnerAuthorityRuntime(environment.database, pilotConfiguration, {
      close: async () => {},
      logbook: { feed: db, snapshots: db },
      gymMcpClients: pilotClients,
      plugins: [testSessionBridge(createPartnerDatabaseHandle(environment.database))],
    });
    const refused = await environment.authorize(
      client,
      { resource: GYM_MCP_RESOURCE, scopes: ['gyms:read'] },
      { handler: (request) => pilotRuntime.handleRequest(request) },
    );
    expect(refused.response.status).toBe(403);
  });

  it('keeps refresh rotation and immediate disconnect for discovered clients', async () => {
    const { client, issued, owner } = await issueGymTokens();
    const refreshed = await environment.refresh(client, issued.refresh_token!, target);
    expect(refreshed.response.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(issued.refresh_token);
    const accessToken = refreshed.body.access_token!;
    expect((await runtime.gymMcpApi!.authenticate(accessToken)).principal).toBeDefined();
    await disconnectPartnerConnection(environment.database, {
      userId: owner.userId,
      clientId: CLIENT_ID,
      reason: 'climber_disconnect',
    });
    expect((await runtime.gymMcpApi!.authenticate(accessToken)).principal).toBeUndefined();
    const afterDisconnect = await environment.refresh(client, refreshed.body.refresh_token!, target);
    expect(afterDisconnect.body.error).toBe('invalid_grant');
    expect(
      await db
        .select()
        .from(oauthClient)
        .where(and(eq(oauthClient.clientId, CLIENT_ID), eq(oauthClient.disabled, false))),
    ).toHaveLength(1);
  });

  it('blocks already issued credentials when the server-owned client policy is suspended', async () => {
    const { issued } = await issueGymTokens();
    await db
      .update(oauthMcpClientPolicy)
      .set({ suspendedAt: new Date() })
      .where(eq(oauthMcpClientPolicy.clientId, CLIENT_ID));
    try {
      expect((await runtime.gymMcpApi!.authenticate(issued.access_token!)).refusal).toBe('client_disabled');
    } finally {
      await db
        .update(oauthMcpClientPolicy)
        .set({ suspendedAt: null })
        .where(eq(oauthMcpClientPolicy.clientId, CLIENT_ID));
    }
  });

  it('commits retry receipts once, rejects revoked writes, and retains expired-key tombstones', async () => {
    const { issued, owner } = await issueGymTokens();
    const principal = (await runtime.gymMcpApi!.authenticate(issued.access_token!)).principal!;
    const runtimeMock = vi.spyOn(runtimeLoader, 'loadPartnerAuthority').mockResolvedValue(runtime);
    vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
    vi.stubEnv('GYM_MCP_MODE', 'on');
    try {
      const { executeGymMcpWriteAction } = await import('../../../mcp/gyms/dispatch');
      const arguments_ = { idempotencyKey: randomUUID(), gymUuid: randomUUID() };
      const work = vi.fn(async () => ({ accepted: true }));
      expect(await executeGymMcpWriteAction(principal, 'test_action', arguments_, 'gyms:write', work)).toEqual({
        accepted: true,
      });
      expect(await executeGymMcpWriteAction(principal, 'test_action', arguments_, 'gyms:write', work)).toEqual({
        accepted: true,
      });
      expect(work).toHaveBeenCalledTimes(1);
      await expect(
        executeGymMcpWriteAction(principal, 'different_action', arguments_, 'gyms:write', work),
      ).rejects.toMatchObject({ extensions: { code: 'IDEMPOTENCY_CONFLICT' } });
      await db
        .update(gymMcpWriteReceipts)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(gymMcpWriteReceipts.idempotencyKey, arguments_.idempotencyKey));
      expect(await sweepGymMcpReceiptPayloads()).toBe(1);
      const [tombstone] = await db
        .select()
        .from(gymMcpWriteReceipts)
        .where(eq(gymMcpWriteReceipts.idempotencyKey, arguments_.idempotencyKey));
      expect(tombstone.result).toBeNull();
      expect(tombstone.operationName).toBe('test_action');
      expect(tombstone.inputHash).toEqual(expect.any(String));
      await expect(
        executeGymMcpWriteAction(principal, 'test_action', arguments_, 'gyms:write', work),
      ).rejects.toMatchObject({ extensions: { code: 'IDEMPOTENCY_EXPIRED' } });
      expect(work).toHaveBeenCalledTimes(1);
      await disconnectPartnerConnection(environment.database, {
        userId: owner.userId,
        clientId: CLIENT_ID,
        reason: 'climber_disconnect',
      });
      await expect(withGymMcpWrite(principal, 'gyms:write', async () => 'unreachable')).rejects.toMatchObject({
        extensions: { code: 'UNAUTHENTICATED' },
      });
    } finally {
      runtimeMock.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('preserves repeatable read for grade selection through the authorized outer transaction and savepoint', async () => {
    const { issued } = await issueGymTokens();
    const principal = (await runtime.gymMcpApi!.authenticate(issued.access_token!)).principal!;
    const runtimeMock = vi.spyOn(runtimeLoader, 'loadPartnerAuthority').mockResolvedValue(runtime);
    vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
    vi.stubEnv('GYM_MCP_MODE', 'on');
    try {
      const { executeGymMcpWriteAction } = await import('../../../mcp/gyms/dispatch');
      const readIsolation = async () => {
        const rows = await db.execute<{ level: string }>(sql`SELECT current_setting('transaction_isolation') AS level`);
        return Array.from(rows)[0]!.level;
      };
      await expect(
        executeGymMcpWriteAction(
          principal,
          'set_gym_grade_collection',
          { idempotencyKey: randomUUID(), gymUuid: randomUUID() },
          'gyms:write',
          async () => ({
            outer: await readIsolation(),
            resolver: await db.transaction(readIsolation, { isolationLevel: 'repeatable read' }),
          }),
        ),
      ).resolves.toEqual({ outer: 'repeatable read', resolver: 'repeatable read' });
    } finally {
      runtimeMock.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('replays simultaneous same-key grade writes from a fresh snapshot with one committed receipt and effect', async () => {
    const { issued } = await issueGymTokens();
    const principal = (await runtime.gymMcpApi!.authenticate(issued.access_token!)).principal!;
    const runtimeMock = vi.spyOn(runtimeLoader, 'loadPartnerAuthority').mockResolvedValue(runtime);
    vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
    vi.stubEnv('GYM_MCP_MODE', 'on');
    let releaseFirst!: () => void;
    let noteFirstWork!: () => void;
    let noteSecondSnapshot!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstWorkStarted = new Promise<void>((resolve) => {
      noteFirstWork = resolve;
    });
    const secondSnapshotStarted = new Promise<void>((resolve) => {
      noteSecondSnapshot = resolve;
    });
    const originalLock = connectionLocks.lockPartnerConnection;
    let lockAttempts = 0;
    const lockMock = vi.spyOn(connectionLocks, 'lockPartnerConnection').mockImplementation(async (...arguments_) => {
      lockAttempts += 1;
      // The initial set_config SELECT has already established this snapshot.
      if (lockAttempts === 2) noteSecondSnapshot();
      return originalLock(...arguments_);
    });
    const committedEffect = vi.fn();
    const inFlight: Array<Promise<unknown>> = [];
    try {
      const { executeGymMcpWriteAction } = await import('../../../mcp/gyms/dispatch');
      const arguments_ = { idempotencyKey: randomUUID(), gymUuid: randomUUID() };
      const work = async () => {
        noteFirstWork();
        await firstMayCommit;
        await deferDatabaseEffect(committedEffect);
        return { accepted: true };
      };
      const first = executeGymMcpWriteAction(principal, 'set_gym_grade_collection', arguments_, 'gyms:write', work);
      inFlight.push(first);
      await firstWorkStarted;
      const second = executeGymMcpWriteAction(principal, 'set_gym_grade_collection', arguments_, 'gyms:write', work);
      inFlight.push(second);
      await secondSnapshotStarted;
      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual([{ accepted: true }, { accepted: true }]);
      expect(committedEffect).toHaveBeenCalledOnce();
      const receipts = await db
        .select()
        .from(gymMcpWriteReceipts)
        .where(eq(gymMcpWriteReceipts.idempotencyKey, arguments_.idempotencyKey));
      expect(receipts).toHaveLength(1);
      expect(lockAttempts).toBe(3);
    } finally {
      releaseFirst();
      await Promise.allSettled(inFlight);
      lockMock.mockRestore();
      runtimeMock.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
