import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionDetailTick } from '@boardsesh/shared-schema';

vi.mock('../playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: vi.fn(),
}));

import { getBoardConfigForPlaylist } from '../playlists/board-details-for-playlist';
import { sessionTickToClimb, navigateToSessionClimb } from '../session-tick-mapping';

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
    betaLinks: [],
    ...overrides,
  };
}

describe('sessionTickToClimb', () => {
  it('returns null without frames (falls back to the plain text row)', () => {
    expect(sessionTickToClimb(makeTick({ frames: null }))).toBeNull();
  });

  it('maps a framed tick onto the ClimbListItemClimb shape', () => {
    const climb = sessionTickToClimb(
      makeTick({
        climbUuid: 'climb-7',
        climbName: 'Crimp City',
        frames: 'p1145r15',
        difficultyName: 'V6',
        setterUsername: 'setter-bob',
      }),
    );

    expect(climb).toMatchObject({
      uuid: 'climb-7',
      name: 'Crimp City',
      frames: 'p1145r15',
      difficulty: 'V6',
      ascensionist_count: 0,
      setter_username: 'setter-bob',
    });
  });

  it('sets benchmark_difficulty only when the tick is a benchmark', () => {
    const benchmark = sessionTickToClimb(makeTick({ frames: 'p1', difficultyName: 'V5', isBenchmark: true }));
    expect(benchmark?.benchmark_difficulty).toBe('V5');

    const nonBenchmark = sessionTickToClimb(makeTick({ frames: 'p1', difficultyName: 'V5', isBenchmark: false }));
    expect(nonBenchmark?.benchmark_difficulty).toBeNull();
  });

  it('passes through mirrored and is_no_match flags', () => {
    const climb = sessionTickToClimb(makeTick({ frames: 'p1', isMirror: true, isNoMatch: true }));
    expect(climb?.mirrored).toBe(true);
    expect(climb?.is_no_match).toBe(true);
  });

  it('keeps the community star average hidden by defaulting quality_average to "0"', () => {
    const climb = sessionTickToClimb(makeTick({ frames: 'p1', quality: 3 }));
    expect(climb?.quality_average).toBe('0');
  });

  it('coalesces null name, difficultyName and setterUsername to empty strings', () => {
    const climb = sessionTickToClimb(
      makeTick({ frames: 'p1', climbName: null, difficultyName: null, setterUsername: null }),
    );
    expect(climb?.name).toBe('');
    expect(climb?.difficulty).toBe('');
    expect(climb?.setter_username).toBe('');
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
