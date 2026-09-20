/** #5291: drive the real HTTP context, GraphQL schema, resolver and both limiters.
 * Only database reads, token verification and Redis I/O are replaced. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';

const { redisCounts, redisState, redisEval, validateTokenMock, findSimilarClimbsMock } = vi.hoisted(() => ({
  redisCounts: new Map<string, number>(),
  redisState: { connected: true, failing: false },
  redisEval: vi.fn(),
  validateTokenMock: vi.fn(),
  findSimilarClimbsMock: vi.fn(),
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    onRedisReady: vi.fn(),
    isRedisConnected: () => redisState.connected,
    getClients: () => ({ publisher: { eval: redisEval } }),
  },
}));
vi.mock('../db/client', () => {
  const database = {
    select: () => ({ from: () => ({ where: async () => [{ holdId: 1, holdState: 'STARTING' }] }) }),
  };
  return { db: database, dbRead: database };
});
vi.mock('../graphql/resolvers/climbs/similar-climbs-cache', () => ({
  findSimilarClimbsCached: findSimilarClimbsMock,
}));
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  validateToken: validateTokenMock,
}));

import { buildHttpConnectionContext, createYogaInstance } from '../graphql/yoga';

const SERVICE_SECRET = 'test-internal-service-secret';
const QUERY = `query SimilarClimbs($input: SimilarClimbsInput!) { similarClimbs(input: $input) { uuid } }`;
type QueryResult = {
  data?: { similarClimbs: { uuid: string }[] } | null;
  errors?: { extensions: { code?: string; retryAfterSeconds?: number } }[];
};

describe('similar-climbs service identity over HTTP', () => {
  let server: Server;
  let graphqlUrl: string;

  beforeAll(async () => {
    const yoga = createYogaInstance();
    server = createServer((request, response) => {
      void yoga.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP test port');
    graphqlUrl = `http://127.0.0.1:${address.port}/graphql`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('INTERNAL_SERVICE_SECRET', SERVICE_SECRET);
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    // Fix the bucket clock without faking timers used by the HTTP server.
    vi.spyOn(Date, 'now').mockReturnValue(1_789_300_800_000);
    resetAllRateLimits();
    redisCounts.clear();
    redisState.connected = true;
    redisState.failing = false;
    redisEval.mockReset();
    redisEval.mockImplementation(async (_script: string, _numKeys: number, key: string) => {
      if (redisState.failing) throw new Error('Redis unavailable');
      const count = (redisCounts.get(key) ?? 0) + 1;
      redisCounts.set(key, count);
      return count;
    });
    validateTokenMock.mockReset();
    validateTokenMock.mockImplementation(async (token: string) =>
      token === 'user-token' ? { userId: 'user-42' } : null,
    );
    findSimilarClimbsMock.mockReset();
    findSimilarClimbsMock.mockResolvedValue([{ uuid: 'related-climb' }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function read(climbUuid: string, authorization: string | undefined = `Bearer ${SERVICE_SECRET}`, angle = 40) {
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify({
        query: QUERY,
        variables: { input: { boardType: 'kilter', layoutId: 1, climbUuid, angle } },
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as QueryResult;
  }

  function expectLoaded(result: QueryResult) {
    expect(result.errors).toBeUndefined();
    expect(result.data?.similarClimbs).toEqual([{ uuid: 'related-climb' }]);
  }

  function expectLimited(result: QueryResult) {
    expect(result.errors?.[0].extensions).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: expect.any(Number),
    });
  }

  it('serves 400 distinct climbs plus another visitor through one socket address', async () => {
    const results = await Promise.all(Array.from({ length: 400 }, (_, index) => read(`climb-${index}`)));
    results.forEach(expectLoaded);
    expectLoaded(await read('another-visitor'));
    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(401);
    expect(redisCounts.size).toBe(401);
    expect(validateTokenMock).not.toHaveBeenCalled();
  });

  it('blocks request 31 for one climb while allowing another climb and angle', async () => {
    for (let index = 0; index < 30; index++) expectLoaded(await read('same-climb'));
    expectLimited(await read('same-climb'));
    expectLoaded(await read('different-climb'));
    expectLoaded(await read('same-climb', `Bearer ${SERVICE_SECRET}`, 0));
  });

  it.each(['', 'Bearer incorrect-secret', SERVICE_SECRET])(
    'keeps public or invalid credentials on one IP bucket despite rotating climbs (%s)',
    async (authorization) => {
      for (let index = 0; index < 30; index++) expectLoaded(await read(`public-${index}`, authorization));
      expectLimited(await read('public-31', authorization));
      expect(redisCounts.size).toBe(0);
    },
  );

  it('falls back to anonymous limits when the backend secret is absent', async () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', '');
    for (let index = 0; index < 30; index++) expectLoaded(await read(`missing-secret-${index}`));
    expectLimited(await read('missing-secret-31'));
  });

  it('shares the partition ceiling through Redis after local counters reset on another instance', async () => {
    for (let index = 0; index < 20; index++) expectLoaded(await read('shared-climb'));
    resetAllRateLimits();
    for (let index = 0; index < 10; index++) expectLoaded(await read('shared-climb'));
    expectLimited(await read('shared-climb'));
    expectLoaded(await read('other-instance-climb'));
  });

  it.each(['disconnected', 'command-failure'])(
    'keeps the local ceiling without double-counting when Redis is %s',
    async (failure) => {
      redisState.connected = failure !== 'disconnected';
      redisState.failing = failure === 'command-failure';
      for (let index = 0; index < 30; index++) expectLoaded(await read('outage-climb'));
      expectLimited(await read('outage-climb'));
    },
  );

  it('does not honor an HTTP service flag on a WebSocket context', async () => {
    const context = {
      connectionId: 'ws-caller',
      transport: 'ws' as const,
      clientIp: '203.0.113.1',
      isInternalService: true,
    };
    for (let index = 0; index < 30; index++) {
      await applyRateLimit(context, 30, 'similar-climbs', { internalServicePartition: `climb-${index}` });
    }
    await expect(
      applyRateLimit(context, 30, 'similar-climbs', { internalServicePartition: 'climb-31' }),
    ).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
  });

  it('keeps the unpartitioned service fallback finite', async () => {
    const context = { connectionId: 'http-service', transport: 'http' as const, isInternalService: true };
    for (let index = 0; index < 300; index++) await applyRateLimit(context, 30, 'unpartitioned');
    await expect(applyRateLimit(context, 30, 'unpartitioned')).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED' },
    });
  });

  it.each([
    [`Bearer ${SERVICE_SECRET}`, false, false, true, undefined],
    ['Bearer test-cron-secret', false, true, false, undefined],
    ['Bearer user-token', true, false, false, 'user-42'],
    ['Bearer incorrect', false, false, false, undefined],
  ])(
    'keeps user, cron and service privileges separate for %s',
    async (authorization, isAuthenticated, isCronAuthenticated, isInternalService, userId) => {
      const context = await buildHttpConnectionContext({
        request: new Request(graphqlUrl, { headers: { Authorization: authorization } }),
      });
      expect(context).toMatchObject({
        transport: 'http',
        isAuthenticated,
        isCronAuthenticated,
        isInternalService,
        userId,
      });
    },
  );
});
