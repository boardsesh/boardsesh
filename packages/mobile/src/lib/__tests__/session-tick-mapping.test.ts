import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionDetailTick } from '@boardsesh/shared-schema';

vi.mock('../playlists/board-details-for-playlist', () => ({
  renderBoardToPlaylistConfig: vi.fn(),
}));

import { renderBoardToPlaylistConfig } from '../playlists/board-details-for-playlist';
import { sessionTickToClimb, navigateToSessionClimb } from '../session-tick-mapping';
import { resolveDisplayGrade } from '../boardsesh-grade-display';

const mockedGetBoardConfig = vi.mocked(renderBoardToPlaylistConfig);

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

  // The Boardsesh grade only fills in for an UNGRADED tick (`difficulty == null`,
  // the same signal SessionTickRow's frameless path uses). A logged/consensus
  // grade always wins, so the fields must be dropped when one is present — else
  // ClimbListItemContent's unconditional swap would override the user's grade.
  it('carries the Boardsesh grade fields for an ungraded tick (difficulty == null)', () => {
    const climb = sessionTickToClimb(
      makeTick({ frames: 'p1', difficulty: null, boardseshDifficulty: 20, boardseshConfidence: 'confirmed' }),
    );
    expect(climb?.boardseshDifficulty).toBe(20);
    expect(climb?.boardseshConfidence).toBe('confirmed');
  });

  it('OMITS the Boardsesh grade fields when the tick has a logged grade (difficulty set)', () => {
    const climb = sessionTickToClimb(
      makeTick({ frames: 'p1', difficulty: 12, boardseshDifficulty: 20, boardseshConfidence: 'confirmed' }),
    );
    expect(climb).not.toHaveProperty('boardseshDifficulty');
    expect(climb).not.toHaveProperty('boardseshConfidence');
    expect(climb?.boardseshDifficulty).toBeUndefined();
  });
});

// End-to-end grade resolution for the FRAMED session-tick path: the climb built
// by `sessionTickToClimb` is rendered through `resolveDisplayGrade` — the exact
// pure resolver `ClimbListItemContent` calls via `useDisplayGrade`. The
// `useBoardseshGrades` argument mirrors `useBoardseshGradesActive` (flag AND the
// climber's "Show Boardsesh grades" preference), so `true` == toggle ON.
describe('sessionTickToClimb → resolveDisplayGrade (framed path grade)', () => {
  const gradeFormat = 'v-grade' as const;
  function resolveFramedGrade(tick: SessionDetailTick, useBoardseshGrades: boolean) {
    const climb = sessionTickToClimb(tick);
    if (!climb) throw new Error('expected a framed climb');
    return resolveDisplayGrade(climb, { useBoardseshGrades, gradeFormat });
  }

  it('(a) ungraded framed tick + toggle ON → renders the Boardsesh grade', () => {
    // 20 = 6c/V5; the ungraded legacy label is blank, so the swap is observable.
    const tick = makeTick({
      frames: 'p1',
      difficulty: null,
      difficultyName: null,
      boardseshDifficulty: 20,
      boardseshConfidence: 'confirmed',
    });
    expect(resolveFramedGrade(tick, true)).toEqual({
      label: 'V5',
      color: expect.stringMatching(/^#/),
      isBoardsesh: true,
      isEstimated: false,
    });
  });

  it('(b) ungraded framed tick + toggle OFF → legacy grade, never Boardsesh', () => {
    const tick = makeTick({
      frames: 'p1',
      difficulty: null,
      difficultyName: '6b/V4',
      boardseshDifficulty: 20,
      boardseshConfidence: 'confirmed',
    });
    expect(resolveFramedGrade(tick, false)).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });
  });

  it('(c) GRADED framed tick + toggle ON → renders the USER grade, NOT the Boardsesh grade', () => {
    // The critical user-grade-wins case: the logger graded V4; the Boardsesh grade
    // (V5) is present on the tick but must be dropped so it can never override.
    const tick = makeTick({
      frames: 'p1',
      difficulty: 12,
      difficultyName: '6b/V4',
      boardseshDifficulty: 20,
      boardseshConfidence: 'confirmed',
    });
    const display = resolveFramedGrade(tick, true);
    expect(display).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });
    expect(display.label).not.toBe('V5');
  });

  it('(d) ungraded framed tick with a setter_only or null Boardsesh grade → legacy, never Boardsesh', () => {
    const setterOnly = makeTick({
      frames: 'p1',
      difficulty: null,
      difficultyName: '6b/V4',
      boardseshDifficulty: 27,
      boardseshConfidence: 'setter_only',
    });
    expect(resolveFramedGrade(setterOnly, true)).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });

    const noGrade = makeTick({
      frames: 'p1',
      difficulty: null,
      difficultyName: '6b/V4',
      boardseshDifficulty: null,
      boardseshConfidence: null,
    });
    expect(resolveFramedGrade(noGrade, true)).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });
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
