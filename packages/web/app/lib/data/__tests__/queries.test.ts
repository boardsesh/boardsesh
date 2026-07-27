// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getClimb } from '../queries';

const { mockSqlTag, rowsFromResultMock } = vi.hoisted(() => {
  const mockSqlTag = vi.fn();
  const rowsFromResultMock = <T>(result: unknown): T[] => {
    if (Array.isArray(result)) return result as T[];
    throw new TypeError('Expected postgres-js query result to be a row array');
  };
  return { mockSqlTag, rowsFromResultMock };
});

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  unstable_cache:
    <T extends (...args: unknown[]) => unknown>(fn: T) =>
    (...args: Parameters<T>) =>
      fn(...args),
}));

vi.mock('@/app/lib/db/db', () => ({
  sql: mockSqlTag,
  rowsFromResult: rowsFromResultMock,
}));

describe('getClimb', () => {
  beforeEach(() => {
    mockSqlTag.mockReset();
  });

  it('maps layoutId, boardType, and derives difficulty/is_no_match from characteristics', async () => {
    mockSqlTag.mockResolvedValueOnce([]); // alias lookup: no alias, uuid unchanged
    mockSqlTag.mockResolvedValueOnce([
      {
        uuid: 'climb-uuid-1',
        setter_username: 'setter1',
        userId: 'user-1',
        name: 'Test Climb',
        description: null,
        layoutId: 8,
        boardType: 'kilter',
        frames: 'p1r12p2r13',
        framesCount: 1,
        framesPace: 0,
        angle: 40,
        ascensionist_count: 12,
        difficulty_id: 20,
        quality_average: '2.50',
        difficulty_error: '0.10',
        benchmark_difficulty: null,
        is_draft: false,
        created_at: '2024-01-01T00:00:00.000Z',
        published_at: '2024-01-02T00:00:00.000Z',
        characteristics: ['no_match'],
      },
    ]);

    const climb = await getClimb({
      board_name: 'kilter',
      layout_id: 8,
      size_id: 10,
      set_ids: [1, 2],
      angle: 40,
      climb_uuid: 'climb-uuid-1',
    });

    expect(mockSqlTag).toHaveBeenCalledTimes(2);
    expect(climb.uuid).toBe('climb-uuid-1');
    expect(climb.layoutId).toBe(8);
    expect(climb.boardType).toBe('kilter');
    expect(climb.difficulty).toBe('6c/V5');
    expect(climb.is_no_match).toBe(true);
    expect(climb.ascensionist_count).toBe(12);
  });

  it('derives is_no_match from the description prefix when characteristics is null', async () => {
    mockSqlTag.mockResolvedValueOnce([]); // alias lookup: no alias, uuid unchanged
    mockSqlTag.mockResolvedValueOnce([
      {
        uuid: 'climb-uuid-2',
        setter_username: 'setter2',
        userId: null,
        name: 'Legacy Climb',
        description: 'No match\nSome beta notes',
        layoutId: 1,
        boardType: 'kilter',
        frames: 'p1r12',
        framesCount: 1,
        framesPace: 0,
        angle: 40,
        ascensionist_count: 0,
        difficulty_id: null,
        quality_average: null,
        difficulty_error: null,
        benchmark_difficulty: null,
        is_draft: false,
        created_at: '2024-01-01T00:00:00.000Z',
        published_at: null,
        characteristics: null,
      },
    ]);

    const climb = await getClimb({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 10,
      set_ids: [1, 2],
      angle: 40,
      climb_uuid: 'climb-uuid-2',
    });

    expect(climb.layoutId).toBe(1);
    expect(climb.boardType).toBe('kilter');
    expect(climb.difficulty).toBe('');
    expect(climb.is_no_match).toBe(true);
  });

  it('is_no_match is false when characteristics has no no_match token and the description does not start with "no match"', async () => {
    mockSqlTag.mockResolvedValueOnce([]); // alias lookup: no alias, uuid unchanged
    mockSqlTag.mockResolvedValueOnce([
      {
        uuid: 'climb-uuid-3',
        setter_username: 'setter3',
        userId: null,
        name: 'Normal Climb',
        description: 'Great warmup',
        layoutId: 1,
        boardType: 'tension',
        frames: 'p1r12',
        framesCount: 1,
        framesPace: 0,
        angle: 40,
        ascensionist_count: 3,
        difficulty_id: 22,
        quality_average: '3.00',
        difficulty_error: '0.00',
        benchmark_difficulty: null,
        is_draft: false,
        created_at: '2024-01-01T00:00:00.000Z',
        published_at: '2024-01-01T00:00:00.000Z',
        characteristics: ['method_footless'],
      },
    ]);

    const climb = await getClimb({
      board_name: 'tension',
      layout_id: 1,
      size_id: 10,
      set_ids: [1],
      angle: 40,
      climb_uuid: 'climb-uuid-3',
    });

    expect(climb.boardType).toBe('tension');
    expect(climb.difficulty).toBe('7a/V6');
    expect(climb.is_no_match).toBe(false);
  });

  it('resolves an old/merged climb link through board_climb_aliases to the canonical uuid', async () => {
    mockSqlTag.mockResolvedValueOnce([{ canonical_uuid: 'canonical-uuid-9' }]); // alias hit
    mockSqlTag.mockResolvedValueOnce([
      {
        uuid: 'canonical-uuid-9',
        setter_username: 'setter9',
        userId: null,
        name: 'Merged Climb',
        description: '',
        layoutId: 3,
        boardType: 'moonboard',
        frames: 'p1r42',
        framesCount: 1,
        framesPace: 0,
        angle: 40,
        ascensionist_count: 5,
        difficulty_id: 20,
        quality_average: '3.50',
        difficulty_error: '0.00',
        benchmark_difficulty: null,
        is_draft: false,
        created_at: '2024-01-01T00:00:00.000Z',
        published_at: '2024-01-01T00:00:00.000Z',
        characteristics: null,
      },
    ]);

    const climb = await getClimb({
      board_name: 'moonboard',
      layout_id: 3,
      size_id: 1,
      set_ids: [1],
      angle: 40,
      climb_uuid: 'old-alias-uuid-9', // a bookmarked link to the now-delisted row
    });

    expect(mockSqlTag).toHaveBeenCalledTimes(2);
    // The climb query (2nd call) must have queried by the RESOLVED canonical
    // uuid, not the alias — otherwise this renders an empty husk instead of
    // the merged climb's real data. Call args are [strings, ...interpolated
    // values]; check the interpolated values only.
    const [, ...climbQueryValues] = mockSqlTag.mock.calls[1];
    expect(climbQueryValues).toContain('canonical-uuid-9');
    expect(climbQueryValues).not.toContain('old-alias-uuid-9');
    expect(climb.uuid).toBe('canonical-uuid-9');
  });
});
