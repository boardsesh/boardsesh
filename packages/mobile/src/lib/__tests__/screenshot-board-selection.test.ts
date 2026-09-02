import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { matchScreenshotBoard, type ScreenshotSelectableBoard } from '../screenshot-board-selection';

function board(overrides: Partial<ScreenshotSelectableBoard> & { name: string }): ScreenshotSelectableBoard {
  return {
    layoutName: null,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    angle: 40,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('matchScreenshotBoard', () => {
  const roster = [
    board({ name: "Test User's MoonBoard 2016", boardType: 'moonboard', createdAt: '2026-03-01T00:00:00.000Z' }),
    board({ name: "Marco's Kilterboard", layoutName: 'Kilter Board Homewall', createdAt: '2026-02-01T00:00:00.000Z' }),
    board({
      name: 'The Cellar',
      layoutName: 'Tension Board 2',
      boardType: 'tension',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  ];

  it('matches a board by its own name, ignoring case and padding', () => {
    expect(matchScreenshotBoard(roster, "  marco's KILTERBOARD ")?.name).toBe("Marco's Kilterboard");
  });

  it('matches through the punctuation and spacing a human would vary', () => {
    // A selector is hand-typed and the name it has to hit was hand-typed too;
    // a capture must not fail over a curly apostrophe or a missing space.
    for (const spelling of ['Marco’s Kilter Board', 'Marcos Kilterboard', 'marco-s-kilterboard']) {
      expect(matchScreenshotBoard(roster, spelling)?.name).toBe("Marco's Kilterboard");
    }
  });

  it('matches a board by its layout name when no board is called that', () => {
    expect(matchScreenshotBoard(roster, 'Tension Board 2')?.name).toBe('The Cellar');
  });

  it('prefers an exact layout-name match over a longer name that merely contains the selector', () => {
    const withDecoyName = [board({ name: 'Tension Board 2 (old garage)' }), ...roster];
    expect(matchScreenshotBoard(withDecoyName, 'Tension Board 2')?.name).toBe('The Cellar');
  });

  it('falls back to a substring match on the name', () => {
    expect(matchScreenshotBoard(roster, 'moonboard')?.boardType).toBe('moonboard');
  });

  it('returns null for a selector nothing matches, and for an empty selector', () => {
    expect(matchScreenshotBoard(roster, 'Grasshopper Wall')).toBeNull();
    expect(matchScreenshotBoard(roster, '   ')).toBeNull();
  });
});

describe('resolveScreenshotBoard', () => {
  const originalBoardsEnv = process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS;
  const roster = [
    // Deliberately in the order myBoards returns (isOwned DESC, createdAt DESC),
    // which is the order that used to decide the shot.
    board({ name: 'Newest Follow', boardType: 'moonboard', createdAt: '2026-03-01T00:00:00.000Z' }),
    board({ name: "Marco's Kilterboard", createdAt: '2026-02-01T00:00:00.000Z' }),
    board({
      name: 'The Cellar',
      layoutName: 'Tension Board 2',
      boardType: 'tension',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  ];

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalBoardsEnv === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS;
    else process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = originalBoardsEnv;
    vi.restoreAllMocks();
  });

  it('resolves each slot from the configured selectors, not from position', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = "Marco's Kilterboard|Tension Board 2";
    const { resolveScreenshotBoard } = await import('../screenshot-board-selection');
    expect(resolveScreenshotBoard(roster, 0)?.name).toBe("Marco's Kilterboard");
    expect(resolveScreenshotBoard(roster, 1)?.name).toBe('The Cellar');
  });

  it('warns and falls back to oldest-first position when a selector matches nothing', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = 'Grasshopper Wall';
    const { resolveScreenshotBoard } = await import('../screenshot-board-selection');
    expect(resolveScreenshotBoard(roster, 0)?.name).toBe('The Cellar');
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(logged).toContain('[screenshot] WARN board[0] selector "Grasshopper Wall" matched nothing');
    // The failing run has to hand over the roster; the fix is always "use one of
    // these", and reading it off a phone instead costs another 20-minute capture.
    expect(logged).toContain('"Newest Follow"');
    expect(logged).toContain('"The Cellar" (Tension Board 2 L1 S7 @40°)');
  });

  it('stays quiet while the roster query is still in flight', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = "Marco's Kilterboard";
    const { resolveScreenshotBoard } = await import('../screenshot-board-selection');
    expect(resolveScreenshotBoard([], 0)).toBeNull();
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });

  it('warns on a slot the run never named, so a partial retarget cannot shoot a drifting wall', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = "Marco's Kilterboard";
    const { resolveScreenshotBoard } = await import('../screenshot-board-selection');
    expect(resolveScreenshotBoard(roster, 1)?.name).toBe("Marco's Kilterboard");
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      '[screenshot] WARN board[1] has no selector (1 configured); using position',
    );
  });

  it('returns null when the fallback position is past the end of the roster', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = "Marco's Kilterboard";
    const { resolveScreenshotBoard } = await import('../screenshot-board-selection');
    expect(resolveScreenshotBoard(roster, 9)).toBeNull();
  });
});
