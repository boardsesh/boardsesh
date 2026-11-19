import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLError } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { describe, expect, it, vi } from 'vite-plus/test';
import { typeDefs, type ConnectionContext } from '@boardsesh/shared-schema';
import { maskDatabaseError } from '../../graphql/mask-error';
import { userQueries } from '../../graphql/resolvers/users/queries';
import { currentGarminFunction } from './garmin-source';

// The identity scalar reads only the admitted request context. A database call
// would fail here instead of silently reaching an ambient application database.
vi.mock('../../db/client', () => ({ db: undefined, dbRead: undefined }));

const anonymous: ConnectionContext = { connectionId: 'watch-launch', isAuthenticated: false };
const signedIn: ConnectionContext = { ...anonymous, isAuthenticated: true, userId: 'watch-owner' };

function watchReplay() {
  return {
    body: currentGarminFunction('net/BsEndpoints.mc', 'mySessionsBody', {}) as () => unknown,
    needsRefresh: currentGarminFunction('net/BsClient.mc', 'graphqlSessionsAuthRequired', {}) as (
      code: number,
      reply: unknown,
    ) => boolean,
  };
}

async function exchange(context: ConnectionContext, sessions: unknown[] = []) {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: {
      Query: {
        authenticatedUserId: userQueries.authenticatedUserId,
        mySessions: () => sessions,
      },
    },
  });
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    context: () => context,
    logging: false,
    maskedErrors: { maskError: maskDatabaseError },
  });
  const response = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(watchReplay().body()),
  });
  return { code: response.status, reply: (await response.json()) as unknown };
}

/** Replay the current request consumer; no SDK or hardware claim. */
function requestReplay(field: string | null = 'mySessions', authed = true) {
  const observed: Array<{ code: number; payload: unknown }> = [];
  let refreshes = 0;
  let isCurrent = true;
  const replay = watchReplay();
  const scope: Record<string, unknown> = {
    _settled: false,
    _retried: false,
    _authed: authed,
    _unwrapField: field,
    _captured: {},
    TokenStore: { current: () => isCurrent },
    BsResponse: { STALE: -32001 },
    BsAuthReply: {
      graphqlAuthRequired: currentGarminFunction('net/BsClient.mc', 'graphqlAuthRequired', {}),
      graphqlSessionsAuthRequired: replay.needsRefresh,
    },
    _client: { handleUnauthorized: () => (refreshes += 1) },
    _cb: { invoke: (code: number, payload: unknown) => observed.push({ code, payload }) },
    self: {},
    fail: (code: number) => {
      scope._settled = true;
      observed.push({ code, payload: null });
    },
    _unwrap: (reply: { data?: Record<string, unknown> } | null) => (field ? (reply?.data?.[field] ?? null) : reply),
  };
  const receive = currentGarminFunction('net/BsClient.mc', 'onResponse', scope, 'BsRequest');
  return {
    receive,
    observed,
    refreshes: () => refreshes,
    supersede: () => (isCurrent = false),
  };
}

describe('current Garmin session discovery through the real GraphQL transport', () => {
  it('asks for admitted identity so an expired bearer cannot look like an empty session list', async () => {
    const watch = watchReplay();
    const response = await exchange(anonymous);
    expect(response.code).toBe(200);
    expect(response.reply).toMatchObject({
      data: null,
      errors: [
        { message: 'Authentication required', path: ['authenticatedUserId'], extensions: { code: 'UNAUTHENTICATED' } },
      ],
    });
    expect(watch.needsRefresh(response.code, response.reply)).toBe(true);
    const request = requestReplay();
    request.receive(response.code, response.reply);
    expect(request.refreshes()).toBe(1);
    expect(request.observed).toEqual([]);

    const sessions = [{ id: 'session-one', name: 'Evening', boardPath: '/kilter', isActive: true }];
    const refreshed = await exchange(signedIn, sessions);
    request.receive(refreshed.code, refreshed.reply);
    expect(request.refreshes()).toBe(1);
    expect(request.observed).toEqual([{ code: 200, payload: sessions }]);
  });

  it('does not spend a refresh secret when an authenticated climber has no active sessions', async () => {
    const response = await exchange(signedIn);
    expect(response.reply).toEqual({ data: { authenticatedUserId: 'watch-owner', mySessions: [] } });
    expect(watchReplay().needsRefresh(response.code, response.reply)).toBe(false);
    const request = requestReplay();
    request.receive(response.code, response.reply);
    expect(request.refreshes()).toBe(0);
    expect(request.observed).toEqual([{ code: 200, payload: [] }]);
  });

  it('retries once and settles even if the replacement bearer is also rejected', async () => {
    const response = await exchange(anonymous);
    const request = requestReplay();
    request.receive(response.code, response.reply);
    request.receive(response.code, response.reply);
    request.receive(response.code, response.reply);
    expect(request.refreshes()).toBe(1);
    expect(request.observed).toEqual([{ code: 200, payload: null }]);
  });

  it('requires the exact identity refusal and never treats an outage or malformed reply as anonymous', () => {
    const identityError = new GraphQLError('Authentication required', {
      path: ['authenticatedUserId'],
      extensions: { code: 'UNAUTHENTICATED' },
    }).toJSON();
    const controls = [
      { data: { mySessions: [] } },
      { errors: [{ ...identityError, path: ['mySessions'] }] },
      { errors: [{ ...identityError, path: ['authenticatedUserId', 'nested'] }] },
      { errors: [{ ...identityError, message: 'Something went wrong' }] },
      { errors: [{ ...identityError, extensions: { code: 'SERVICE_UNAVAILABLE' } }] },
      { errors: [{ ...identityError, extensions: null }] },
      { errors: [{ ...identityError, path: null }] },
      { errors: 'not-an-array' },
      null,
    ];
    for (const reply of controls) expect(watchReplay().needsRefresh(200, reply)).toBe(false);
    for (const code of [-104, 400, 429, 503]) {
      expect(watchReplay().needsRefresh(code, { errors: [identityError] })).toBe(false);
    }
  });

  it('applies the identity check only to the authenticated session discovery request', async () => {
    const response = await exchange(anonymous);
    for (const request of [requestReplay(null), requestReplay('saveTick'), requestReplay('mySessions', false)]) {
      request.receive(response.code, response.reply);
      expect(request.refreshes()).toBe(0);
      expect(request.observed).toHaveLength(1);
    }
    const stale = requestReplay();
    stale.supersede();
    stale.receive(response.code, response.reply);
    expect(stale.refreshes()).toBe(0);
    expect(stale.observed).toEqual([{ code: -32001, payload: null }]);
  });
});
