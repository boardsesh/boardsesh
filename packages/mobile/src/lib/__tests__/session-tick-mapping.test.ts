import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionDetailTick } from '@boardsesh/shared-schema';

vi.mock('../playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: vi.fn(),
}));

import { getBoardConfigForPlaylist } from '../playlists/board-details-for-playlist';
import { sessionTicksToLogbook, navigateToSessionClimb } from '../session-tick-mapping';

const mockedGetBoardConfig = vi.mocked(getBoardConfigForPlaylist);

function makeTick(overrides: Partial<SessionDetailTick> = {}): SessionDetailTick {
  return {
    uuid: 'tick-1',
    userId: 'user-1',
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    status: 'send',
    attemptCount: 2,
    difficulty: 12,
    difficultyName: 'V4',
    quality: null,
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    comment: null,
    frames: null,
    setterUsername: null,
    climbedAt: '2026-06-01T10:00:00.000Z',
    upvotes: 0,
    totalAttempts: 5,
    ...overrides,
  };
}

describe('sessionTicksToLogbook', () => {
  it('buckets ticks by board type', () => {
    const result = sessionTicksToLogbook([
      makeTick({ uuid: 'a', boardType: 'kilter' }),
      makeTick({ uuid: 'b', boardType: 'tension' }),
      makeTick({ uuid: 'c', boardType: 'kilter' }),
    ]);
    expect(Object.keys(result).sort()).toEqual(['kilter', 'tension']);
    expect(result.kilter).toHaveLength(2);
    expect(result.tension).toHaveLength(1);
  });

  it('maps tick fields onto LogbookEntry, mirroring difficulty into effectiveDifficulty', () => {
    const [entry] = sessionTicksToLogbook([makeTick({ difficulty: 12, attemptCount: 3, angle: 40 })]).kilter;
    expect(entry).toMatchObject({
      climbed_at: '2026-06-01T10:00:00.000Z',
      difficulty: 12,
      effectiveDifficulty: 12,
      tries: 3,
      angle: 40,
      status: 'send',
      layoutId: 1,
      boardType: 'kilter',
      climbUuid: 'climb-1',
    });
  });

  it('normalises unknown statuses to attempt and clamps tries to at least 1', () => {
    const [entry] = sessionTicksToLogbook([makeTick({ status: 'repeat', attemptCount: 0 })]).kilter;
    expect(entry.status).toBe('attempt');
    expect(entry.tries).toBe(1);
  });

  it('coalesces a null difficulty to null on both grade fields', () => {
    const [entry] = sessionTicksToLogbook([makeTick({ difficulty: null })]).kilter;
    expect(entry.difficulty).toBeNull();
    expect(entry.effectiveDifficulty).toBeNull();
  });

  it('returns an empty object for no ticks', () => {
    expect(sessionTicksToLogbook([])).toEqual({});
  });
});

describe('navigateToSessionClimb', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('pushes the climb-detail route with stringified board params', () => {
    mockedGetBoardConfig.mockReturnValue({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 20, 33],
    });
    const push = vi.fn();
    navigateToSessionClimb({ push } as never, makeTick({ climbUuid: 'climb-9', angle: 50 }));
    expect(push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/[climbUuid]',
      params: {
        climbUuid: 'climb-9',
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,20,33',
        angle: '50',
      },
    });
  });

  it('does not navigate when the board config cannot resolve (e.g. MoonBoard)', () => {
    mockedGetBoardConfig.mockReturnValue(null);
    const push = vi.fn();
    navigateToSessionClimb({ push } as never, makeTick({ boardType: 'moonboard' }));
    expect(push).not.toHaveBeenCalled();
  });
});
