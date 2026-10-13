import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  matchScreenshotBoard,
  screenshotClimbMatchesBoard,
  screenshotCppClimbListTestId,
  screenshotCppWallHeroTestId,
  type ScreenshotSelectableBoard,
} from '../screenshot-board-selection';
import { matchScreenshotBoardCandidates, parseScreenshotBoardSelectors } from '../screenshot-board-matching';

describe('genuine CPP surface readiness', () => {
  const activeBoard = {
    uuid: 'actual-home-10x10',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 21,
    setIds: '26,27',
    angle: 40,
  };
  const list = {
    captureEnabled: true,
    scene: 'hero-3',
    activeBoard,
    targetUuid: activeBoard.uuid,
    searchReady: true,
    loading: false,
    resolving: false,
    placeholder: false,
    firstClimb: { boardType: 'kilter', layoutId: 8 },
  };
  it('binds the actual loaded list to the requested UUID, not its repeated climb name', () => {
    expect(screenshotCppClimbListTestId(list)).toBe('cpp-climb-list-actual-home-10x10');
    for (const missingProof of [
      { captureEnabled: false },
      { scene: undefined },
      { activeBoard: null },
      { targetUuid: 'actual-home-7x10' },
      { searchReady: false },
      { loading: true },
      { resolving: true },
      { placeholder: true },
      { firstClimb: undefined },
      { firstClimb: { boardType: 'kilter', layoutId: 1 } },
      { firstClimb: { boardType: 'tension', layoutId: 8 } },
    ])
      expect(screenshotCppClimbListTestId({ ...list, ...missingProof })).toBe('climb-list');
    // Same layout/title can occur on both Homewalls. Current-input query
    // readiness must hold after the actual requested UUID was activated.
    const otherGeometry = { ...activeBoard, sizeId: 17 };
    expect(screenshotCppClimbListTestId({ ...list, placeholder: true, activeBoard: otherGeometry })).toBe('climb-list');
  });
  it('binds the real wall hero to the published owned UUID, exact geometry and raw climb ID', () => {
    const hero = {
      captureEnabled: true,
      column: true,
      publishedBoardUuid: activeBoard.uuid,
      activeBoard,
      panelConfig: { boardName: 'kilter', layoutId: 8, sizeId: 21, setIds: '27,26', angle: 40 },
      climbUuid: 'D0E5387D5B974D38B4E93FC4DFD61EF6',
    };
    expect(screenshotCppWallHeroTestId(hero)).toBe('cpp-wall-hero-actual-home-10x10-D0E5387D5B974D38B4E93FC4DFD61EF6');
    for (const missingProof of [
      { captureEnabled: false },
      { column: false },
      { activeBoard: null },
      { publishedBoardUuid: null },
      { publishedBoardUuid: 'actual-home-7x10' },
      { publishedBoardUuid: '999000' },
      { panelConfig: null },
      { climbUuid: '' },
      { panelConfig: { ...hero.panelConfig, sizeId: 17 } },
      { panelConfig: { ...hero.panelConfig, layoutId: 1 } },
      { panelConfig: { ...hero.panelConfig, boardName: 'tension' } },
      { panelConfig: { ...hero.panelConfig, setIds: '27' } },
      { panelConfig: { ...hero.panelConfig, angle: 35 } },
    ])
      expect(screenshotCppWallHeroTestId({ ...hero, ...missingProof })).toBeUndefined();
    expect(screenshotCppWallHeroTestId({ ...hero, climbUuid: '62f43f16-9ac8-59d7-8803-794268fec151' })).toBe(
      'cpp-wall-hero-actual-home-10x10-62f43f16-9ac8-59d7-8803-794268fec151',
    );
  });
});

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

  it('keeps the first native board when the winning name tier has several matches', () => {
    const first = board({ name: 'Marco’s Kilter Board' });
    const second = board({ name: 'Marcos Kilterboard' });
    expect(matchScreenshotBoard([first, second], 'Marco-s Kilterboard')).toBe(first);
  });

  it('prefers an exact name over an earlier exact layout', () => {
    const earlierLayout = board({ name: 'Other wall', layoutName: 'The Cellar' });
    expect(matchScreenshotBoard([earlierLayout, ...roster], 'The Cellar')).toBe(roster[2]);
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

describe('matchScreenshotBoardCandidates', () => {
  it('returns all normalized exact names in roster order, excluding weaker matches', () => {
    const layoutMatch = { name: 'Other wall', layoutName: 'Marcos Board' };
    const substringMatch = { name: 'Marco’s Board in the shed' };
    const first = { name: "Marco's Board", layoutName: null };
    const second = { name: 'Marcos Board' };
    expect(matchScreenshotBoardCandidates([layoutMatch, substringMatch, first, second], '  MARCO’S Board ')).toEqual([
      first,
      second,
    ]);
  });

  it('returns all exact layouts ahead of name substrings', () => {
    const substringMatch = { name: 'Kilter Board Homewall in the shed' };
    const first = { name: 'Primary', layoutName: 'Kilter Board Homewall' };
    const second = { name: 'Other primary', layoutName: 'Kilter-Board Homewall' };
    expect(matchScreenshotBoardCandidates([substringMatch, first, second], 'Kilter Board Homewall')).toEqual([
      first,
      second,
    ]);
  });

  it('returns all name substrings ahead of layout substrings', () => {
    const layoutMatch = { name: 'Other wall', layoutName: 'A Marco wall' };
    const first = { name: "Marco's Board" };
    const second = { name: 'Garage Marco wall' };
    expect(matchScreenshotBoardCandidates([layoutMatch, first, second], 'Marco')).toEqual([first, second]);
  });

  it('returns all layout substrings when no stronger tier matches', () => {
    const first = { name: 'Primary', layoutName: 'Kilter Board Homewall' };
    const second = { name: 'Other primary', layoutName: 'Tension Homewall' };
    expect(matchScreenshotBoardCandidates([first, second], 'Homewall')).toEqual([first, second]);
  });

  it.each(['', '  ', '!!!', 'Missing wall'])('returns no candidates for %s', (selector) => {
    expect(matchScreenshotBoardCandidates([{ name: 'Primary', layoutName: null }], selector)).toEqual([]);
  });

  it('trims and removes blank selector slots while preserving the remaining order', () => {
    expect(parseScreenshotBoardSelectors(' |  Marco’s Board  || Kilter Board Homewall | ')).toEqual([
      'Marco’s Board',
      'Kilter Board Homewall',
    ]);
    expect(parseScreenshotBoardSelectors(' | | ')).toEqual([]);
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
    // Its own line, so `adb logcat` truncating it can't take the marker with it.
    expect(logged).toContain('[screenshot] board roster: ');
    expect(logged).toContain('"Newest Follow"');
    // The board type closes each description: the showcase recorder's wall check
    // reads it from there, never from a name someone typed.
    expect(logged).toContain('"The Cellar" (Tension Board 2 L1 S7 @40°, tension)');
    expect(logged).toContain('"Newest Follow" (L1 S7 @40°, moonboard)');
    const warnLine = logged.split('\n').find((line) => line.includes('WARN board[0]')) ?? '';
    expect(warnLine).not.toContain('roster');
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

describe('screenshotClimbMatchesBoard', () => {
  it('waits for the requested spray results instead of opening the previous Grasshopper climb', () => {
    const spray = { boardType: 'spray', layoutId: 47 };
    expect(screenshotClimbMatchesBoard({ boardType: 'grasshopper', layoutId: 1 }, spray)).toBe(false);
    expect(screenshotClimbMatchesBoard({ boardType: 'spray', layoutId: 48 }, spray)).toBe(false);
    expect(screenshotClimbMatchesBoard({}, spray)).toBe(false);
    expect(screenshotClimbMatchesBoard({ boardType: 'spray', layoutId: 47 }, spray)).toBe(true);
  });
});
