// Unit-tests the mobile favorite dual-write control flow against the REAL
// on-device DDL (node:sqlite), with the network and DB handle mocked so the
// hook factory can run outside a render tree.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

const invalidateQueries = vi.fn();
type MutationConfig<TVariables> = {
  mutationFn: (variables: TVariables) => Promise<unknown>;
  onSuccess?: (_data: unknown, variables: TVariables) => void;
};
vi.mock('@tanstack/react-query', () => ({
  useMutation: <TVariables>(config: MutationConfig<TVariables>) => config,
  useQueryClient: () => ({ invalidateQueries }),
}));

const request = vi.fn();
vi.mock('../client', () => ({
  getHttpClient: () => ({ request }),
}));

let handle: SQLiteDatabase | null = null;
vi.mock('../../../db', () => ({
  getDatabaseHandle: () => handle,
}));

vi.mock('react-native', () => ({}));
vi.mock('../hooks/use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
vi.mock('../hooks/use-beta-link-preview', () => ({ useBetaLinkPreview: vi.fn() }));
vi.mock('../hooks/use-mobile-climb-actions-data', () => ({ useMobileClimbActionsData: vi.fn() }));
vi.mock('../hooks/use-you-data', () => ({
  useAllBoardsTicks: vi.fn(),
  useUserProfileStats: vi.fn(),
  useUserClimbPercentile: vi.fn(),
  useUserAscentsFeed: vi.fn(),
  useSessionGroupedFeed: vi.fn(),
}));
vi.mock('../hooks/use-you-profile-data', () => ({ useYouProfileData: vi.fn() }));
vi.mock('../hooks/use-social', () => ({
  useVote: vi.fn(),
  useBulkVoteSummaries: vi.fn(),
  useComments: vi.fn(),
  useAddComment: vi.fn(),
}));
vi.mock('../hooks/use-session-detail', () => ({ useSessionDetail: vi.fn(), useSessionPreview: vi.fn() }));

import { useToggleFavorite } from '../hooks';
import { __resetDrainerStateForTests } from '../../../mutation-queue/drainer';
import { runMigrations } from '../../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../../db/__tests__/sqlite-test-db';

type Row = Record<string, unknown>;
type ToggleVariables = { input: { boardName: string; climbUuid: string; angle: number }; currentlyFavorited?: boolean };
type ConfigOf<TVariables> = {
  mutationFn: (variables: TVariables) => Promise<unknown>;
  onSuccess?: (_data: unknown, variables: TVariables) => void;
};
const asConfig = <TVariables>(hookResult: unknown): ConfigOf<TVariables> => hookResult as ConfigOf<TVariables>;

const parkedRequest = () => new Promise<never>(() => {});

let db: TestSqliteDb;

beforeEach(async () => {
  invalidateQueries.mockClear();
  request.mockReset();
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await runMigrations(db);
  handle = db;
});

afterEach(() => {
  __resetDrainerStateForTests();
  handle = null;
});

describe('useToggleFavorite dual-write', () => {
  it('currentlyFavorited=false with a DB handle: adds locally + enqueues create', async () => {
    request.mockImplementation(parkedRequest);
    const { mutationFn } = asConfig<ToggleVariables>(useToggleFavorite());

    await mutationFn({
      input: { boardName: 'kilter', climbUuid: 'climb-fav-1', angle: 40 },
      currentlyFavorited: false,
    });

    const favorite = await db.getFirstAsync<Row>(
      'SELECT * FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?',
      ['kilter', 'climb-fav-1', 40],
    );
    expect(favorite).not.toBeNull();

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].operation).toBe('create');
    expect(queued[0].idempotency_key).toBe('add:user_favorites:kilter:climb-fav-1:40');
  });

  it('currentlyFavorited=true with a DB handle: removes locally + enqueues delete', async () => {
    request.mockImplementation(parkedRequest);
    await db.runAsync(
      "INSERT INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at) VALUES ('kilter', 'climb-fav-2', 40, 'now', 'now')",
    );
    const { mutationFn } = asConfig<ToggleVariables>(useToggleFavorite());

    await mutationFn({
      input: { boardName: 'kilter', climbUuid: 'climb-fav-2', angle: 40 },
      currentlyFavorited: true,
    });

    const remaining = await db.getAllAsync<Row>('SELECT * FROM user_favorites WHERE climb_uuid = ?', ['climb-fav-2']);
    expect(remaining).toHaveLength(0);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].operation).toBe('delete');
    expect(queued[0].idempotency_key).toBe('del:user_favorites:kilter:climb-fav-2:40');
  });

  it('without a DB handle: falls back to the online TOGGLE_FAVORITE request', async () => {
    handle = null;
    request.mockResolvedValue({ toggleFavorite: { favorited: true } });
    const { mutationFn } = asConfig<ToggleVariables>(useToggleFavorite());

    await mutationFn({
      input: { boardName: 'kilter', climbUuid: 'climb-online-fav', angle: 40 },
      currentlyFavorited: false,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('toggleFavorite');
    expect(request.mock.calls[0][1]).toEqual({
      input: { boardName: 'kilter', climbUuid: 'climb-online-fav', angle: 40 },
    });

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(0);
  });

  it('without currentlyFavorited: preserves the existing online toggle behavior', async () => {
    request.mockResolvedValue({ toggleFavorite: { favorited: true } });
    const { mutationFn } = asConfig<ToggleVariables>(useToggleFavorite());

    await mutationFn({
      input: { boardName: 'kilter', climbUuid: 'climb-online-toggle', angle: 40 },
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({
      input: { boardName: 'kilter', climbUuid: 'climb-online-toggle', angle: 40 },
    });
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
  });
});
