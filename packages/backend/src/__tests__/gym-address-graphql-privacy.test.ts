import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GraphQLError } from 'graphql';

const { mockLogger, preview } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  preview: vi.fn(() => ({ latitude: 52.37, longitude: 4.9 })),
}));
vi.mock('../utils/logger', () => ({ logger: mockLogger }));
vi.mock('../middleware/auth', () => ({ validateToken: vi.fn(async () => null) }));
vi.mock('../graphql/resolvers/users/analytics-consent', () => ({
  readAnalyticsConsentForUser: vi.fn(async () => null),
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));
vi.mock('../graphql/index', async () => {
  const { makeExecutableSchema } = await import('@graphql-tools/schema');
  return {
    schema: makeExecutableSchema({
      typeDefs: `
      type Query { lookupGymAddressCoordinates(address: String!): GymAddressCoordinates }
      type GymAddressCoordinates { latitude: Float! longitude: Float! }
    `,
      resolvers: { Query: { lookupGymAddressCoordinates: preview } },
    }),
  };
});
import { createYogaInstance } from '../graphql/yoga';
import { sanitizeAddressLookupError } from '../graphql/address-lookup-privacy';

const ADDRESS = 'Private home address marker';
async function request(query: string, variables?: unknown): Promise<string> {
  const response = await createYogaInstance().fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return response.text();
}
function expectPrivate(response: string) {
  expect(response).toContain('Address lookup could not be processed');
  expect(response).not.toContain(ADDRESS);
  expect(
    inspect(
      Object.values(mockLogger).flatMap((method) => method.mock.calls),
      { depth: 20 },
    ),
  ).not.toContain(ADDRESS);
  expect(preview).not.toHaveBeenCalled();
}
beforeEach(() => vi.clearAllMocks());
describe('address lookup GraphQL input privacy', () => {
  it('does not echo invalid variable values to responses or logs', async () => {
    expectPrivate(
      await request('query Lookup($address:String!){lookupGymAddressCoordinates(address:$address){latitude}}', {
        address: [ADDRESS],
      }),
    );
  });
  it('does not echo invalid literals or parse-error sources', async () => {
    expectPrivate(await request(`query {lookupGymAddressCoordinates(address:["${ADDRESS}"]){latitude}}`));
    expectPrivate(await request(`query {lookupGymAddressCoordinates(address:"${ADDRESS}"){`));
  });
  it('removes original errors, source nodes and arbitrary extensions for socket errors', () => {
    const error = new GraphQLError(ADDRESS, {
      originalError: new Error(ADDRESS),
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 10, address: ADDRESS },
    });
    const sanitized = sanitizeAddressLookupError(error, 'query { lookupGymAddressCoordinates }');
    expect(inspect(sanitized, { depth: 20 })).not.toContain(ADDRESS);
    expect(sanitized.extensions).toEqual({ code: 'RATE_LIMITED', retryAfterSeconds: 10 });
  });
});
