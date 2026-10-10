import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { appleAdsAttributionTypeDefs } from '@boardsesh/shared-schema';

const { mockLogger, mockExchange } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  mockExchange: vi.fn(),
}));

vi.mock('../utils/logger', () => ({ logger: mockLogger }));
vi.mock('../middleware/auth', () => ({ validateToken: vi.fn(async () => null) }));
vi.mock('../graphql/resolvers/users/analytics-consent', () => ({
  readAnalyticsConsentForUser: vi.fn(async () => null),
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));
vi.mock('../services/apple-ads-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/apple-ads-attribution')>();
  return { ...actual, exchangeAppleAdsToken: mockExchange };
});

vi.mock('../graphql/index', async () => {
  const { makeExecutableSchema } = await import('@graphql-tools/schema');
  const { appleAdsAttributionMutations } = await import('../graphql/resolvers/users/apple-ads-attribution');
  return {
    schema: makeExecutableSchema({
      typeDefs: ['type Query { health: Boolean! } type Mutation { health: Boolean! }', appleAdsAttributionTypeDefs],
      resolvers: { Mutation: appleAdsAttributionMutations },
    }),
  };
});

import { createYogaInstance } from '../graphql/yoga';

const SENTINEL_TOKEN = 'secret_adservices_sentinel';
const query = `mutation Exchange($token: String!, $consent: AppleAdsConsentInput!) {
  exchangeAppleAdsAttribution(token: $token, consent: $consent) { status }
}`;
const consent = { analytics: 'granted', version: 1, source: 'ios', decidedAt: '2026-10-10T00:00:00.000Z' };

async function request(document: string, variables?: unknown, headers?: Record<string, string>): Promise<string> {
  const yoga = createYogaInstance();
  const response = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query: document, variables }),
  });
  return response.text();
}

function loggedContent(): string {
  return inspect(
    Object.values(mockLogger).flatMap((method) => method.mock.calls),
    { depth: 20 },
  );
}

describe('GraphQL AdServices credential privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExchange.mockResolvedValue({
      status: 'UNATTRIBUTED',
      attribution: null,
      retryReason: null,
      retryAfterSeconds: null,
    });
  });

  it('allows anonymous grants but refuses an invalid supplied bearer before Apple is contacted', async () => {
    expect(await request(query, { token: SENTINEL_TOKEN, consent })).toContain('UNATTRIBUTED');
    mockExchange.mockClear();
    expect(await request(query, { token: SENTINEL_TOKEN, consent }, { Authorization: 'Bearer invalid' })).toContain(
      'CONSENT_REQUIRED',
    );
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('redacts token values from GraphQL coercion errors and generic logs', async () => {
    const response = await request(query, { token: [SENTINEL_TOKEN], consent });
    expect(response).toContain('Apple Ads attribution request could not be processed');
    expect(response).not.toContain(SENTINEL_TOKEN);
    expect(loggedContent()).not.toContain(SENTINEL_TOKEN);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('removes a token literal retained by an invalid GraphQL document', async () => {
    const response = await request(`mutation { exchangeAppleAdsAttribution(token: "${SENTINEL_TOKEN}", consent: {`);
    expect(response).toContain('Apple Ads attribution request could not be processed');
    expect(response).not.toContain(SENTINEL_TOKEN);
    expect(loggedContent()).not.toContain(SENTINEL_TOKEN);
  });

  it('does not alter ordinary public GraphQL validation errors', async () => {
    const response = await request('{ missingField }');
    expect(response).toContain('Cannot query field');
    expect(response).not.toContain('Apple Ads attribution request could not be processed');
  });
});
