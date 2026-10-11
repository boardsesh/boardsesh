// The no-board climbs preview: which setups it offers and when it shows at all.
// The setups run against the real board catalogue, because a preview is only
// useful if this build can draw the board it names.
import { describe, expect, it } from 'vitest';
import type { BoardName, PopularBoardConfig } from '@boardsesh/shared-schema';
import {
  ANGLES,
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
} from '@boardsesh/board-config';
import {
  decideNoBoardState,
  holdsNoBoardDecision,
  isProfileSettled,
  resolvePreviewConfigs,
  type NoBoardPreviewConfig,
  type NoBoardStateInput,
} from '../no-board-preview';

function popular(overrides: Partial<PopularBoardConfig>): PopularBoardConfig {
  return {
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 0,
    setIds: [],
    setNames: [],
    climbCount: 0,
    totalAscents: 0,
    boardCount: 0,
    displayName: 'Popular setup',
    ...overrides,
  };
}

/** The `skip`-th real (layout, size, sets) setup in this build's catalogue. */
function catalogueSetup(boardName: BoardName, skip = 0) {
  let remaining = skip;
  for (const layout of getBoardLayouts(boardName)) {
    for (const size of getBoardSizesForLayoutId(boardName, layout.id)) {
      const setIds = getBoardSetsForLayoutAndSize(boardName, layout.id, size.id).map((set) => set.id);
      if (setIds.length === 0) continue;
      if (remaining === 0) return { layoutId: layout.id, sizeId: size.id, setIds };
      remaining -= 1;
    }
  }
  throw new Error(`the ${boardName} catalogue has no setup number ${skip}`);
}

describe('resolvePreviewConfigs', () => {
  it('offers one setup per board type, in the order the popular list names them', () => {
    const tension = catalogueSetup('tension');
    const kilter = catalogueSetup('kilter');
    const configs = resolvePreviewConfigs([
      popular({ boardType: 'tension', ...tension }),
      popular({ boardType: 'kilter', ...kilter }),
      popular({ boardType: 'kilter', ...catalogueSetup('kilter', 1) }),
      popular({ boardType: 'tension', ...catalogueSetup('tension', 1) }),
    ]);

    expect(configs).toEqual([
      {
        boardName: 'tension',
        layoutId: tension.layoutId,
        sizeId: tension.sizeId,
        setIds: tension.setIds.join(','),
        angle: 40,
      },
      {
        boardName: 'kilter',
        layoutId: kilter.layoutId,
        sizeId: kilter.sizeId,
        setIds: kilter.setIds.join(','),
        angle: 40,
      },
    ]);
  });

  // The same rule the board builder's preset follows: a setup this build cannot
  // draw is skipped for the next one of that type.
  it('skips a setup this build does not know and takes the next of that type', () => {
    const kilter = catalogueSetup('kilter', 1);
    const configs = resolvePreviewConfigs([
      popular({ boardType: 'kilter', layoutId: 99_999, sizeId: 1, setIds: [1] }),
      popular({ boardType: 'kilter', ...kilter }),
    ]);

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ boardName: 'kilter', layoutId: kilter.layoutId, sizeId: kilter.sizeId });
  });

  it('drops a board type none of whose popular setups this build can draw', () => {
    const configs = resolvePreviewConfigs([
      popular({ boardType: 'tension', layoutId: 99_999, sizeId: 1, setIds: [1] }),
      popular({ boardType: 'kilter', ...catalogueSetup('kilter') }),
    ]);

    expect(configs.map((config) => config.boardName)).toEqual(['kilter']);
  });

  // The live list has only Kilter and Tension setups. A guessed MoonBoard is
  // the 2010 board, which almost no current owner has.
  it('offers no MoonBoard while the popular list carries none', () => {
    const configs = resolvePreviewConfigs([
      popular({ boardType: 'kilter', ...catalogueSetup('kilter') }),
      popular({ boardType: 'tension', ...catalogueSetup('tension') }),
    ]);

    expect(configs.some((config) => config.boardName === 'moonboard')).toBe(false);
  });

  it('offers a MoonBoard at its own angle once the popular list carries one', () => {
    const moonboard = catalogueSetup('moonboard');
    const configs = resolvePreviewConfigs([popular({ boardType: 'moonboard', ...moonboard })]);

    expect(configs).toHaveLength(1);
    expect(configs[0].boardName).toBe('moonboard');
    expect(ANGLES.moonboard).toContain(configs[0].angle);
  });

  it('ignores board types this build has never heard of, and a spray wall', () => {
    expect(
      resolvePreviewConfigs([
        popular({ boardType: 'not-a-board', layoutId: 1, sizeId: 1, setIds: [1] }),
        popular({ boardType: 'spray', layoutId: 1, sizeId: 1, setIds: [1] }),
      ]),
    ).toEqual([]);
  });

  it('offers nothing while the popular list has not loaded, or is empty', () => {
    expect(resolvePreviewConfigs(undefined)).toEqual([]);
    expect(resolvePreviewConfigs(null)).toEqual([]);
    expect(resolvePreviewConfigs([])).toEqual([]);
  });
});

const KILTER_PREVIEW: NoBoardPreviewConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
};

/** A signed-in, online, zero-board account with everything loaded: the preview case. */
function previewInput(overrides: Partial<NoBoardStateInput> = {}): NoBoardStateInput {
  return {
    authSettled: true,
    isAuthenticated: true,
    isOffline: false,
    flagsResolved: true,
    previewEnabled: true,
    boardsStatus: 'ready',
    ownedBoardCount: 0,
    profileSettled: true,
    popularStatus: 'ready',
    previewConfigs: [KILTER_PREVIEW],
    ...overrides,
  };
}

describe('decideNoBoardState', () => {
  it('shows the preview to an online account with no boards and a setup to show', () => {
    expect(decideNoBoardState(previewInput())).toEqual({
      status: 'preview',
      configs: [KILTER_PREVIEW],
      ownedBoardCount: 0,
    });
  });

  // A climber whose active board was only cleared (a sign-out, an unfollow) is
  // one tap from their own list. A stranger's wall is the wrong thing to show.
  it('keeps the placard for an account that has boards', () => {
    expect(decideNoBoardState(previewInput({ ownedBoardCount: 3 }))).toEqual({
      status: 'placard',
      fallbackReason: 'has_boards',
      ownedBoardCount: 3,
    });
  });

  it('keeps the placard with the kill switch on, still reporting the board count', () => {
    expect(decideNoBoardState(previewInput({ previewEnabled: false }))).toEqual({
      status: 'placard',
      fallbackReason: 'kill_switch',
      ownedBoardCount: 0,
    });
  });

  it.each([
    ['the session is still being read', { authSettled: false }],
    ['the flags have not resolved', { flagsResolved: false }],
    ['the board list is loading', { boardsStatus: 'pending' }],
    ['the profile is loading', { profileSettled: false }],
    ['the popular list is loading', { popularStatus: 'pending', previewConfigs: [] }],
  ] as const)('waits while %s', (_name, overrides) => {
    expect(decideNoBoardState(previewInput(overrides))).toEqual({ status: 'pending' });
  });

  // A kill switch flipped in PostHog must land before anything is swapped in.
  it('does not let an unresolved flag bag show the preview', () => {
    expect(decideNoBoardState(previewInput({ flagsResolved: false, previewEnabled: true })).status).toBe('pending');
  });

  // None of the reads below it can finish offline, so it must not wait on them.
  it('answers offline at once, without waiting for the flags or the board list', () => {
    expect(
      decideNoBoardState(
        previewInput({ isOffline: true, flagsResolved: false, boardsStatus: 'pending', profileSettled: false }),
      ),
    ).toEqual({ status: 'placard', fallbackReason: 'offline', ownedBoardCount: null });
  });

  it('reports a cached board count offline', () => {
    expect(decideNoBoardState(previewInput({ isOffline: true, ownedBoardCount: 2 }))).toEqual({
      status: 'placard',
      fallbackReason: 'offline',
      ownedBoardCount: 2,
    });
  });

  // A failed read is unknown state, never evidence of an account with no boards.
  it('keeps the placard when the board list could not be read', () => {
    expect(decideNoBoardState(previewInput({ boardsStatus: 'error' }))).toEqual({
      status: 'placard',
      fallbackReason: 'boards_unknown',
      ownedBoardCount: null,
    });
  });

  it.each([
    ['failed', { popularStatus: 'error', previewConfigs: [] }],
    ['carried nothing this build can draw', { popularStatus: 'ready', previewConfigs: [] }],
  ] as const)('keeps the placard when the popular list %s', (_name, overrides) => {
    expect(decideNoBoardState(previewInput(overrides))).toEqual({
      status: 'placard',
      fallbackReason: 'no_config',
      ownedBoardCount: 0,
    });
  });

  it('keeps the placard for a signed-out visitor, whatever else is true', () => {
    expect(decideNoBoardState(previewInput({ isAuthenticated: false }))).toEqual({
      status: 'placard',
      fallbackReason: 'signed_out',
      ownedBoardCount: null,
    });
  });
});

// Climbs stays mounted for the whole session, so a held answer lasts until a
// relaunch. Only the ones a later read cannot make wrong may be held.
describe('holdsNoBoardDecision', () => {
  it('holds a preview, so a refetch never swaps the list away', () => {
    expect(holdsNoBoardDecision({ status: 'preview', configs: [KILTER_PREVIEW], ownedBoardCount: 0 })).toBe(true);
  });

  it.each(['has_boards', 'kill_switch'] as const)('holds a %s placard', (fallbackReason) => {
    expect(holdsNoBoardDecision({ status: 'placard', fallbackReason, ownedBoardCount: 0 })).toBe(true);
  });

  // A launch in a signal gap must not cost the climber the preview until relaunch.
  it.each(['offline', 'boards_unknown', 'no_config', 'signed_out'] as const)(
    'decides a %s placard again',
    (fallbackReason) => {
      expect(holdsNoBoardDecision({ status: 'placard', fallbackReason, ownedBoardCount: null })).toBe(false);
    },
  );
});

describe('isProfileSettled', () => {
  it('is not settled while the first read is pending', () => {
    expect(isProfileSettled({ hasProfile: false, isPending: true, isFetching: true })).toBe(false);
  });

  // Sign-in invalidates the `null` the signed-out tree cached: not pending, but
  // the real profile is still on its way.
  it('is not settled while a refetch runs over a cached null', () => {
    expect(isProfileSettled({ hasProfile: false, isPending: false, isFetching: true })).toBe(false);
  });

  it('is settled with a profile in hand, refetching or not', () => {
    expect(isProfileSettled({ hasProfile: true, isPending: false, isFetching: true })).toBe(true);
    expect(isProfileSettled({ hasProfile: true, isPending: false, isFetching: false })).toBe(true);
  });

  it('is settled once the read has finished with nothing', () => {
    expect(isProfileSettled({ hasProfile: false, isPending: false, isFetching: false })).toBe(true);
  });
});
