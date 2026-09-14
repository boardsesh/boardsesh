import { describe, it, expect, vi } from 'vitest';
import {
  configKey,
  climbConfigKey,
  deriveAcceptedConfigs,
  decideAdd,
  isClimbOnReachableBoard,
  type ClimbBoardCompatibility,
  type ClimbBoardIdentityLike,
} from '../cross-board';

const KILTER = { boardName: 'kilter', layoutId: 1 };

function climbItem(boardType?: string | null, layoutId?: number | null) {
  return { climb: { boardType, layoutId } };
}

function classifyStub(result: ClimbBoardCompatibility) {
  return vi.fn(() => result);
}

describe('configKey / climbConfigKey', () => {
  it('keys a board by name + layout only (size and sets are deliberately excluded)', () => {
    expect(configKey(KILTER)).toBe('kilter:1');
    expect(configKey({ boardName: 'kilter', layoutId: 8 })).toBe('kilter:8');
    expect(configKey({ boardName: 'tension', layoutId: 1 })).toBe('tension:1');
  });

  it('is stable across calls with an equal-but-not-identical config', () => {
    expect(configKey({ ...KILTER })).toBe(configKey(KILTER));
  });

  it('reads a climb key only when BOTH board name and layout are present', () => {
    expect(climbConfigKey({ boardType: 'tension', layoutId: 10 })).toBe('tension:10');
    expect(climbConfigKey({})).toBeNull();
    expect(climbConfigKey({ boardType: 'tension' })).toBeNull();
    expect(climbConfigKey({ layoutId: 10 })).toBeNull();
    expect(climbConfigKey({ boardType: '', layoutId: 10 })).toBeNull();
    expect(climbConfigKey({ boardType: 'tension', layoutId: null })).toBeNull();
  });

  it('treats layout 0 as a real layout, not a missing one', () => {
    expect(climbConfigKey({ boardType: 'kilter', layoutId: 0 })).toBe('kilter:0');
  });
});

describe('deriveAcceptedConfigs', () => {
  it('is empty for an empty queue with no active board', () => {
    expect([...deriveAcceptedConfigs([])]).toEqual([]);
  });

  it('holds only the active board for an empty queue', () => {
    expect([...deriveAcceptedConfigs([], KILTER)]).toEqual(['kilter:1']);
  });

  it('ignores queue items with no usable board metadata', () => {
    const accepted = deriveAcceptedConfigs([climbItem(), climbItem('kilter'), climbItem(null, 1)]);
    expect([...accepted]).toEqual([]);
  });

  it('collects every distinct board already in a mixed queue, plus the active board', () => {
    const accepted = deriveAcceptedConfigs(
      [climbItem('kilter', 1), climbItem('tension', 10), climbItem('tension', 10), climbItem('moonboard', 17)],
      KILTER,
    );
    expect([...accepted].sort()).toEqual(['kilter:1', 'moonboard:17', 'tension:10']);
  });

  it('still collects the queue boards when no active board is set', () => {
    const accepted = deriveAcceptedConfigs([climbItem('tension', 10)]);
    expect([...accepted]).toEqual(['tension:10']);
  });
});

describe('decideAdd', () => {
  const foreignClimb: ClimbBoardIdentityLike = { boardType: 'tension', layoutId: 10 };

  it('adds a compatible climb without consulting the accepted set', () => {
    const classify = classifyStub('compatible');
    expect(
      decideAdd({
        climb: { boardType: 'kilter', layoutId: 1 },
        activeConfig: KILTER,
        acceptedConfigKeys: new Set(),
        classify,
      }),
    ).toEqual({ kind: 'add', reason: 'compatible' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('adds a climb with no board signal rather than blocking on missing metadata', () => {
    expect(
      decideAdd({ climb: {}, activeConfig: KILTER, acceptedConfigKeys: new Set(), classify: classifyStub('unknown') }),
    ).toEqual({ kind: 'add', reason: 'unknown' });
  });

  it('confirms a foreign-board climb the queue has never accepted', () => {
    expect(
      decideAdd({
        climb: foreignClimb,
        activeConfig: KILTER,
        acceptedConfigKeys: new Set(['kilter:1']),
        classify: classifyStub('incompatible'),
      }),
    ).toEqual({ kind: 'confirm', climbConfigKey: 'tension:10', climbBoardName: 'tension', climbLayoutId: 10 });
  });

  it('short-circuits to add when that board is already in the queue (no second prompt)', () => {
    expect(
      decideAdd({
        climb: foreignClimb,
        activeConfig: KILTER,
        acceptedConfigKeys: new Set(['kilter:1', 'tension:10']),
        classify: classifyStub('incompatible'),
      }),
    ).toEqual({ kind: 'add', reason: 'already-mixed' });
  });

  it('adds an incompatible climb we cannot name (half-known metadata) instead of prompting', () => {
    // There would be nothing to put in the prompt and nothing to remember
    // afterwards, so a prompt here could only repeat forever.
    expect(
      decideAdd({
        climb: { boardType: 'tension' },
        activeConfig: KILTER,
        acceptedConfigKeys: new Set(),
        classify: classifyStub('incompatible'),
      }),
    ).toEqual({ kind: 'add', reason: 'unknown' });
  });

  it('passes the active config straight through to the injected classifier', () => {
    const classify = classifyStub('compatible');
    decideAdd({ climb: foreignClimb, activeConfig: KILTER, acceptedConfigKeys: new Set(), classify });
    expect(classify).toHaveBeenCalledWith(KILTER, foreignClimb);
  });

  it('accepts a classifier typed with a NARROWER board union (contravariance contract)', () => {
    // `classifyClimbBoardCompatibility` in @boardsesh/board-config declares its
    // active board as `{ boardName: BoardName; layoutId: number }`. This package
    // can't import it (dependencies: {} on purpose), so pin the same shape here:
    // if `decideAdd` stopped being generic over the board type, this stops
    // compiling under strictFunctionTypes.
    type BoardName = 'kilter' | 'tension' | 'moonboard';
    const realShapeClassify = (
      activeConfig: { boardName: BoardName; layoutId: number } | undefined,
      climb: ClimbBoardIdentityLike,
    ): ClimbBoardCompatibility => {
      if (!activeConfig) return 'unknown';
      if (climb.boardType == null && climb.layoutId == null) return 'unknown';
      if (climb.boardType != null && climb.boardType !== activeConfig.boardName) return 'incompatible';
      if (climb.layoutId != null && climb.layoutId !== activeConfig.layoutId) return 'incompatible';
      return 'compatible';
    };
    const activeConfig = { boardName: 'kilter' as BoardName, layoutId: 1 };

    expect(
      decideAdd({
        climb: { boardType: 'kilter', layoutId: 1 },
        activeConfig,
        acceptedConfigKeys: new Set(),
        classify: realShapeClassify,
      }),
    ).toEqual({ kind: 'add', reason: 'compatible' });

    expect(
      decideAdd({
        climb: foreignClimb,
        activeConfig,
        acceptedConfigKeys: deriveAcceptedConfigs([], activeConfig),
        classify: realShapeClassify,
      }),
    ).toEqual({ kind: 'confirm', climbConfigKey: 'tension:10', climbBoardName: 'tension', climbLayoutId: 10 });
  });

  it('adds without a prompt when no board is active (nothing to be foreign to)', () => {
    expect(
      decideAdd({
        climb: foreignClimb,
        activeConfig: undefined,
        acceptedConfigKeys: deriveAcceptedConfigs([]),
        classify: classifyStub('unknown'),
      }),
    ).toEqual({ kind: 'add', reason: 'unknown' });
  });
});

// --- Walls at the same gym ---------------------------------------------------
//
// The prompt exists to stop a foreign climb landing by accident. At a gym with
// two walls, queueing from the wall beside you is the deliberate act, so the
// prompt is friction at exactly the wrong moment.

describe('decideAdd reachable walls', () => {
  const KILTER_ACTIVE = { boardName: 'kilter' as const, layoutId: 1 };
  const TENSION_CLIMB = { boardType: 'tension', layoutId: 8 };
  const alwaysIncompatible = () => 'incompatible' as const;

  it('adds without prompting when the climb is on another wall at this gym', () => {
    const decision = decideAdd({
      climb: TENSION_CLIMB,
      activeConfig: KILTER_ACTIVE,
      acceptedConfigKeys: new Set(['kilter:1']),
      reachableConfigKeys: new Set(['tension:8']),
      classify: alwaysIncompatible,
    });

    expect(decision).toEqual({ kind: 'add', reason: 'same-gym' });
  });

  it('still prompts for a board that is not at this gym', () => {
    const decision = decideAdd({
      climb: TENSION_CLIMB,
      activeConfig: KILTER_ACTIVE,
      acceptedConfigKeys: new Set(['kilter:1']),
      reachableConfigKeys: new Set(['moonboard:6']),
      classify: alwaysIncompatible,
    });

    expect(decision.kind).toBe('confirm');
  });

  it('behaves exactly as before when no reachable set is supplied', () => {
    const decision = decideAdd({
      climb: TENSION_CLIMB,
      activeConfig: KILTER_ACTIVE,
      acceptedConfigKeys: new Set(['kilter:1']),
      classify: alwaysIncompatible,
    });

    expect(decision.kind).toBe('confirm');
  });

  // A board already in the queue short-circuits first, so the reason stays the
  // one that explains itself: they said yes to this board already.
  it('reports already-mixed ahead of same-gym', () => {
    const decision = decideAdd({
      climb: TENSION_CLIMB,
      activeConfig: KILTER_ACTIVE,
      acceptedConfigKeys: new Set(['kilter:1', 'tension:8']),
      reachableConfigKeys: new Set(['tension:8']),
      classify: alwaysIncompatible,
    });

    expect(decision).toEqual({ kind: 'add', reason: 'already-mixed' });
  });
});

// Four surfaces navigate, describe, schedule and light by this answer. If they
// disagree the app contradicts itself — the drawer promises a climb the sender
// walks past, or the beat calls the queue ended while a swipe would advance.
describe('isClimbOnReachableBoard', () => {
  const reachable = new Set(['tension:8']);

  it('is true for a climb on a board at this gym', () => {
    expect(isClimbOnReachableBoard({ boardType: 'tension', layoutId: 8 }, reachable)).toBe(true);
  });

  it('is false for a climb on a board that is not', () => {
    expect(isClimbOnReachableBoard({ boardType: 'moonboard', layoutId: 6 }, reachable)).toBe(false);
  });

  // Same fail-open stance as the compatibility classifier: unknown means don't
  // act, never "act as though it's reachable".
  it('is false for a climb carrying no board metadata', () => {
    expect(isClimbOnReachableBoard({}, reachable)).toBe(false);
    expect(isClimbOnReachableBoard({ boardType: 'tension' }, reachable)).toBe(false);
    expect(isClimbOnReachableBoard({ layoutId: 8 }, reachable)).toBe(false);
  });

  it('is false when nothing is in reach', () => {
    expect(isClimbOnReachableBoard({ boardType: 'tension', layoutId: 8 }, undefined)).toBe(false);
    expect(isClimbOnReachableBoard({ boardType: 'tension', layoutId: 8 }, new Set())).toBe(false);
  });
});
