import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildSchema, graphql, isObjectType } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { createCatalogBudgetLimiter, type runCatalogQuery } from '../utils/catalog-budget';
import { catalogIdentity, instrumentCatalogAccess } from '../graphql/catalog-access';

const harness = vi.hoisted(() => ({ run: vi.fn<typeof runCatalogQuery>() }));
vi.mock('../utils/catalog-budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/catalog-budget')>()),
  runCatalogQuery: (...args: Parameters<typeof runCatalogQuery>) => harness.run(...args),
}));

const guest: ConnectionContext = {
  connectionId: 'http-guest',
  transport: 'http',
  isAuthenticated: false,
  trustedClientIp: '203.0.113.7',
};

function fixture() {
  const schema = buildSchema(`
    type Climb { uuid: ID! }
    type ClimbSearchResult { climbs: [Climb!]!, hasMore: Boolean!, totalCount: Int! }
    type SyncResult { documents: [Climb!]! }
    type ClimbPage { climbs: [Climb!]!, totalCount: Int!, hasMore: Boolean! }
    input CatalogInput { limit: Int, offset: Int, page: Int, pageSize: Int }
    type Query {
      searchClimbs(page: Int, pageSize: Int): ClimbSearchResult
      climb(uuid: ID): Climb
      syncClimbs(limit: Int): SyncResult
      setterClimbs(input: CatalogInput): ClimbPage
      setterClimbsFull(input: CatalogInput): ClimbPage
      userClimbs(input: CatalogInput): ClimbPage
      playlistClimbs(input: CatalogInput): ClimbPage
      smartPlaylist(input: CatalogInput): ClimbPage
      userFavoriteClimbs(input: CatalogInput): ClimbPage
      similarClimbs(input: CatalogInput): [Climb!]
      myProfile: String
    }
  `);
  const roots = schema.getQueryType()!.getFields();
  roots.searchClimbs.resolve = (_, args: { page?: number; pageSize?: number }) => ({
    searchParams: { page: args.page ?? 0, pageSize: args.pageSize ?? 20 },
    _cachedHasMore: undefined,
  });
  const readClimb = vi.fn(async () => ({ uuid: 'one' }));
  const syncClimbs = vi.fn(async (_: unknown, _args: unknown, context: ConnectionContext) => {
    if (!context.isAuthenticated) throw new Error('Authentication required');
    return { documents: [{ uuid: 'authored-climb' }] };
  });
  roots.climb.resolve = readClimb;
  roots.syncClimbs.resolve = syncClimbs;
  const setterRead = vi.fn(async () => ({ climbs: [{ uuid: 'setter-climb' }], totalCount: 1, hasMore: false }));
  roots.setterClimbs.resolve = setterRead;
  roots.setterClimbsFull.resolve = setterRead;
  roots.userClimbs.resolve = setterRead;
  roots.playlistClimbs.resolve = setterRead;
  roots.smartPlaylist.resolve = setterRead;
  roots.userFavoriteClimbs.resolve = setterRead;
  roots.similarClimbs.resolve = async () => Array.from({ length: 25 }, (_, index) => ({ uuid: String(index) }));
  roots.myProfile.resolve = () => 'unchanged';
  const search = schema.getType('ClimbSearchResult');
  if (!isObjectType(search)) throw new Error('Missing search result type');
  const fields = search.getFields();
  const readRows = vi.fn(async (parent: { _cachedHasMore?: boolean }) => {
    await Promise.resolve();
    parent._cachedHasMore = false;
    return [{ uuid: 'one' }, { uuid: 'two' }];
  });
  const countRows = vi.fn(async () => 2);
  fields.climbs.resolve = readRows;
  fields.totalCount.resolve = countRows;
  fields.hasMore.resolve = async (parent: { _cachedHasMore?: boolean }) => {
    if (parent._cachedHasMore === undefined) await readRows(parent);
    return parent._cachedHasMore;
  };
  instrumentCatalogAccess(schema);
  return { schema, readClimb, readRows, countRows, syncClimbs, setterRead };
}

beforeEach(() => {
  vi.clearAllMocks();
  // General limits already apply before the withdrawn December deadline.
  const limiter = createCatalogBudgetLimiter({ now: () => Date.parse('2026-11-25T00:00:00Z'), redis: () => null });
  harness.run.mockImplementation(limiter.runCatalogQuery);
});

describe('catalog resolver admission', () => {
  it('can instrument a schema built through the other GraphQL module entry point', async () => {
    const esmEntry = 'graphql/index.mjs';
    const otherGraphQL = (await import(esmEntry)) as typeof import('graphql');
    const schema = otherGraphQL.buildSchema(`
      type ClimbSearchResult { totalCount: Int! }
      type Query { searchClimbs: ClimbSearchResult }
    `);
    expect(() => instrumentCatalogAccess(schema)).not.toThrow();
  });

  it('counts parallel aliases individually and refuses excess work before resolvers execute', async () => {
    const { schema, readClimb } = fixture();
    const result = await graphql({
      schema,
      source: `{ ${Array.from({ length: 12 }, (_, index) => `c${index}: climb { uuid }`).join(' ')} }`,
      contextValue: guest,
    });
    expect(readClimb).toHaveBeenCalledTimes(6);
    expect(result.errors).toHaveLength(6);
    expect(result.errors?.[0].extensions).toMatchObject({
      code: 'RATE_LIMITED',
      operation: 'climb',
      retryAfterSeconds: expect.any(Number),
      snapshotManifestUrl: expect.stringContaining('snapshots.boardsesh.com'),
    });
  });

  it('deduplicates simultaneous search fields and holds admission around the lazy reads', async () => {
    const { schema, readRows, countRows } = fixture();
    const result = await graphql({
      schema,
      source:
        '{ searchClimbs(page: 150, pageSize: 100) { hasMore climbs { uuid } copy: climbs { uuid } totalCount count: totalCount } }',
      contextValue: guest,
    });
    expect(result.errors).toBeUndefined();
    expect(readRows).toHaveBeenCalledOnce();
    expect(countRows).toHaveBeenCalledOnce();
    expect(harness.run).toHaveBeenCalledTimes(2);
    expect(harness.run.mock.calls.map(([, request]) => request)).toEqual([
      { operation: 'searchClimbs.climbs', lane: 'interactive', requestedRows: 100, workUnits: 4 },
      { operation: 'searchClimbs.totalCount', lane: 'interactive', requestedRows: 0, workUnits: 3 },
    ]);
  });

  it('meters hasMore-only and count-only queries rather than leaving a lazy-read bypass', async () => {
    const { schema, readRows, countRows } = fixture();
    const result = await graphql({
      schema,
      source: '{ rows: searchClimbs { hasMore } count: searchClimbs { totalCount } }',
      contextValue: guest,
    });
    expect(result.errors).toBeUndefined();
    expect(readRows).toHaveBeenCalledOnce();
    expect(countRows).toHaveBeenCalledOnce();
    expect(harness.run).toHaveBeenCalledTimes(2);
  });

  it('preserves sync authentication and gives authenticated recovery its separate budget', async () => {
    const { schema } = fixture();
    const source = '{ syncClimbs(limit: 500) { documents { uuid } } }';
    const denied = await graphql({ schema, source, contextValue: guest });
    expect(denied.errors?.[0].message).toBe('Authentication required');
    const allowed = await graphql({
      schema,
      source,
      contextValue: { ...guest, isAuthenticated: true, userId: 'user-1' },
    });
    expect(allowed.errors).toBeUndefined();
    expect(harness.run.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      { userId: 'user-1', service: undefined, trustedClientIp: '203.0.113.7' },
      { operation: 'syncClimbs', lane: 'sync', requestedRows: 500 },
    ]);
  });

  it('uses the same budget across operations and HTTP/WS contexts', async () => {
    const { schema } = fixture();
    // Empty/light queries still consume work and cannot replenish it with filters or transports.
    for (let index = 0; index < 180; index++) {
      const result = await graphql({ schema, source: '{ climb { uuid } }', contextValue: guest });
      expect(result.errors).toBeUndefined();
    }
    const result = await graphql({
      schema,
      source: '{ searchClimbs { totalCount } myProfile }',
      contextValue: { ...guest, transport: 'ws', connectionId: 'new-websocket' },
    });
    expect(result.errors?.[0].extensions.code).toBe('RATE_LIMITED');
    expect(result.data?.myProfile).toBe('unchanged');
  });

  it('ignores unverified identity claims and keeps signed background cache work bounded', () => {
    expect(catalogIdentity({ ...guest, isAuthenticated: false, userId: 'claimed', clientIp: 'forged' })).toEqual({
      userId: undefined,
      service: undefined,
      trustedClientIp: guest.trustedClientIp,
    });
    expect(catalogIdentity({ ...guest, catalogClientIp: 'server-cache' })).toEqual({
      userId: undefined,
      service: 'www-catalog-cache',
      trustedClientIp: 'server-cache',
    });
  });

  it('charges the resolver default of 25 similar climbs when limit is omitted', async () => {
    const { schema } = fixture();
    const result = await graphql({ schema, source: '{ similarClimbs { uuid } }', contextValue: guest });
    expect(result.errors).toBeUndefined();
    const [, request, , countRows] = harness.run.mock.calls[0];
    expect(request.requestedRows).toBe(25);
    expect(countRows?.(result.data?.similarClimbs)).toBe(25);
  });

  it.each(['setterClimbs', 'setterClimbsFull', 'userClimbs', 'playlistClimbs', 'smartPlaylist', 'userFavoriteClimbs'])(
    'prevents %s bypass after catalog quota exhaustion',
    async (operation) => {
      const { schema, setterRead } = fixture();
      for (let index = 0; index < 180; index++) {
        await graphql({ schema, source: '{ climb { uuid } }', contextValue: guest });
      }
      const result = await graphql({ schema, source: `{ ${operation} { totalCount } }`, contextValue: guest });
      expect(result.errors?.[0].extensions.code).toBe('RATE_LIMITED');
      expect(setterRead).not.toHaveBeenCalled();
    },
  );

  it('settles setter list reservations from returned climbs rather than the envelope', async () => {
    const { schema } = fixture();
    await graphql({
      schema,
      source: '{ setterClimbsFull(input: {limit: 100, offset: 10000}) { totalCount } }',
      contextValue: guest,
    });
    const [, request, , countRows] = harness.run.mock.calls[0];
    expect(request).toEqual({ operation: 'setterClimbsFull', lane: 'interactive', requestedRows: 100, workUnits: 6 });
    expect(countRows?.({ climbs: [{ uuid: 'one' }, { uuid: 'two' }], totalCount: 20 })).toBe(2);
  });
});
