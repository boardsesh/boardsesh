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
async function send(query: string, variables?: unknown): Promise<Response> {
  return createYogaInstance().fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}
async function request(query: string, variables?: unknown): Promise<string> {
  return (await send(query, variables)).text();
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
  it('keeps only the safe code, retry delay and status of a request-phase error', () => {
    // No path: the request failed before any resolver ran, so the message,
    // source and original error may all hold the token.
    // A named object, not a literal: Yoga types `http`, and the stray key is the point.
    const http = { status: 401, token: TOKEN };
    const original = new GraphQLError(TOKEN, {
      originalError: new Error(TOKEN),
      extensions: { code: 'UNAUTHENTICATED', token: TOKEN, retryAfterSeconds: 7, http },
    });
    const sanitized = sanitizeBoardShareGraphqlError(original, 'mutation { redeemBoardShareLink }');
    expect(sanitized.extensions).toEqual({ code: 'UNAUTHENTICATED', retryAfterSeconds: 7, http: { status: 401 } });
    expect(inspect(sanitized, { depth: 20 })).not.toContain(TOKEN);
  });
  it("keeps a masked database outage's code and 503", () => {
    // What maskDatabaseError hands back in production: a fresh error with no path.
    const masked = new GraphQLError('Something went wrong on our end. Please try again.', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', http: { status: 503 } },
    });
    expect(sanitizeBoardShareGraphqlError(masked, 'mutation { redeemBoardShareLink }').extensions).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      http: { status: 503 },
    });
  });
  it('leaves an error thrown by the field itself whole', () => {
    const thrown = new GraphQLError('Rate limit exceeded', {
      path: ['redeemBoardShareLink'],
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 12 },
    });
    expect(sanitizeBoardShareGraphqlError(thrown, 'mutation { redeemBoardShareLink }')).toBe(thrown);
  });
  it('leaves ordinary GraphQL validation errors intact', async () => {
    const response = await request('{ missingField }');
    expect(response).toContain('Cannot query field');
    expect(response).not.toContain('Board share link request could not be processed');
  });
});

describe("the share resolvers' own errors over HTTP", () => {
  beforeEach(() => vi.clearAllMocks());
  const redeemDocument = 'mutation Share($token: String!) { redeemBoardShareLink(token: $token) { boardUuid slug } }';
  const previewDocument = 'query Share($token: String!) { boardShareLinkPreview(token: $token) { name } }';
  type ErrorBody = { errors: { message: string; path?: string[]; extensions: Record<string, unknown> }[] };

  it('keeps RATE_LIMITED and its retry delay, so the app can wait and retry once', async () => {
    redeem.mockImplementationOnce(() => {
      throw new GraphQLError('Rate limit exceeded. Try again in 12 seconds.', {
        extensions: { code: 'RATE_LIMITED', operation: 'privacyMutation', retryAfterSeconds: 12 },
      });
    });
    const response = await send(redeemDocument, { token: TOKEN });
    const text = await response.text();
    const [error] = (JSON.parse(text) as ErrorBody).errors;
    expect(error.path).toEqual(['redeemBoardShareLink']);
    expect(error.extensions).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 12 });
    expect(text).not.toContain(TOKEN);
    expect(logs()).not.toContain(TOKEN);
  });

  it('keeps PRIVACY_UNAVAILABLE', async () => {
    preview.mockImplementationOnce(() => {
      throw new GraphQLError('Privacy controls are not available yet', {
        extensions: { code: 'PRIVACY_UNAVAILABLE' },
      });
    });
    const [error] = ((await (await send(previewDocument, { token: TOKEN })).json()) as ErrorBody).errors;
    expect(error.extensions.code).toBe('PRIVACY_UNAVAILABLE');
  });

  it('answers a database outage with its 503', async () => {
    redeem.mockImplementationOnce(() => {
      throw new GraphQLError('Something went wrong on our end. Please try again.', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', http: { status: 503 } },
      });
    });
    const response = await send(redeemDocument, { token: TOKEN });
    expect(response.status).toBe(503);
    expect(((await response.json()) as ErrorBody).errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
