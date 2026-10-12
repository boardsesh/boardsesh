import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GraphQLError } from 'graphql';

const { mockLogger, preview, redeem } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  preview: vi.fn(() => ({ name: 'Board preview' })),
  redeem: vi.fn(() => ({ boardUuid: 'board-id', slug: 'board-slug' })),
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
      type Query { health: Boolean! boardShareLinkPreview(token: String!): BoardShareLinkPreview }
      type Mutation { redeemBoardShareLink(token: String!): BoardShareLinkRedemption! }
      type BoardShareLinkPreview { name: String! }
      type BoardShareLinkRedemption { boardUuid: ID! slug: String! }
    `,
      resolvers: { Query: { boardShareLinkPreview: preview }, Mutation: { redeemBoardShareLink: redeem } },
    }),
  };
});
import { createYogaInstance } from '../graphql/yoga';
import { sanitizeBoardShareGraphqlError } from '../graphql/board-share-token-privacy';

const TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';
const FIELDS = [
  ['query', 'boardShareLinkPreview', '{ name }'],
  ['mutation', 'redeemBoardShareLink', '{ boardUuid slug }'],
] as const;
async function request(query: string, variables?: unknown): Promise<string> {
  const response = await createYogaInstance().fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return response.text();
}
function logs(): string {
  return inspect(
    Object.values(mockLogger).flatMap((method) => method.mock.calls),
    { depth: 20 },
  );
}
function expectPrivate(response: string) {
  expect(response).toContain('Board share link request could not be processed');
  expect(response).not.toContain(TOKEN);
  expect(logs()).not.toContain(TOKEN);
  expect(preview).not.toHaveBeenCalled();
  expect(redeem).not.toHaveBeenCalled();
}

describe('board share tokens before HTTP resolver execution', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(FIELDS)('sanitizes %s %s variable coercion and generic logs', async (operation, field, selection) => {
    expectPrivate(
      await request(`${operation} Share($token: String!) { ${field}(token: $token) ${selection} }`, { token: [TOKEN] }),
    );
  });
  it.each(FIELDS)('sanitizes %s %s invalid literals and retained AST sources', async (operation, field, selection) => {
    expectPrivate(await request(`${operation} { ${field}(token: ["${TOKEN}"]) ${selection} }`));
  });
  it.each(FIELDS)('sanitizes %s %s parse errors', async (operation, field) => {
    expectPrivate(await request(`${operation} { ${field}(token: "${TOKEN}") {`));
  });
  it('preserves safe authorization codes while discarding source, path and original error', () => {
    const original = new GraphQLError(TOKEN, {
      path: [TOKEN],
      originalError: new Error(TOKEN),
      extensions: { code: 'UNAUTHENTICATED', token: TOKEN },
    });
    const sanitized = sanitizeBoardShareGraphqlError(original, 'mutation { redeemBoardShareLink }');
    expect(sanitized.extensions).toEqual({ code: 'UNAUTHENTICATED' });
    expect(inspect(sanitized, { depth: 20 })).not.toContain(TOKEN);
  });
  it('leaves ordinary GraphQL validation errors intact', async () => {
    const response = await request('{ missingField }');
    expect(response).toContain('Cannot query field');
    expect(response).not.toContain('Board share link request could not be processed');
  });
});
