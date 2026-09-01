import { describe, expect, it } from 'vitest';
import {
  resolveCommitBarModel,
  resolveWallPillState,
  resolveWallStateAnnouncement,
  shouldArmBusyWallConfirm,
  shouldShowHolderBadge,
  type CommitBarModel,
  type CommitBarModelInput,
  type WallPillState,
  type WallPillStateInput,
  type WallStateAnnouncement,
  type WallStateAnnouncementInput,
} from '../wall-state';

const MY_CLIMB = 'climb-mine';
const WALL_CLIMB = 'climb-on-the-wall';
const THEIR_CLIMB = 'climb-someone-else';

/** Plain solo, nothing at stake: every ladder rung false, no wall known. */
const pillBase: WallPillStateInput = {
  isAnonymous: false,
  displayedClimbUuid: MY_CLIMB,
  wallClimbUuid: null,
  browseLatchActive: false,
  navigationCommits: false,
  wallDriven: false,
};

/** Signed-in climber on their own head, no preview pinned, nothing armed. */
const commitBase: CommitBarModelInput = {
  previewPinned: false,
  isAnonymous: false,
  boardMismatch: false,
  displayedClimbUuid: MY_CLIMB,
  committedHeadUuid: MY_CLIMB,
  wallClimbUuid: null,
  confirmArmed: false,
  wallDriven: false,
};

describe('resolveWallPillState', () => {
  const cases: Array<[string, Partial<WallPillStateInput>, WallPillState]> = [
    // Rung 1 — the read-only viewer never gets wall chrome, whatever else is true.
    [
      'anonymous viewer, wall lit and a latch up',
      { isAnonymous: true, displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, browseLatchActive: true },
      null,
    ],
    // Rung 2 — displayed equals lit.
    ['displayed climb is the lit one', { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB }, 'onWall'],
    [
      'browsed back onto the lit climb mid-latch — on-wall outranks browsing',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, browseLatchActive: true },
      'onWall',
    ],
    [
      'a lit wall showing a different climb is not on-wall',
      { displayedClimbUuid: MY_CLIMB, wallClimbUuid: THEIR_CLIMB, navigationCommits: true },
      'live',
    ],
    // Rung 3 — the latch.
    ['browse latch up with no wall known', { browseLatchActive: true }, 'browsing'],
    [
      'browse latch outranks a committing navigation',
      { browseLatchActive: true, navigationCommits: true, wallDriven: true },
      'browsing',
    ],
    // Rung 4 — live needs stakes, and either one is enough.
    ['committing navigation over a wall someone is driving', { navigationCommits: true, wallDriven: true }, 'live'],
    [
      'committing navigation with a known lit climb but no link of our own',
      { navigationCommits: true, wallClimbUuid: THEIR_CLIMB },
      'live',
    ],
    // Rung 5 — no stakes, so the leading slot stays empty exactly as today.
    ['plain solo: nothing lit, no session, no link', {}, null],
    ['connected but not committing (lightOnSwipe off, still on the head)', { wallDriven: true }, null],
    ['committing with nothing at stake', { navigationCommits: true }, null],
    // The regression: the Start button opens a session solo, so "a session
    // exists" used to light the pill on a phone with nothing connected at all.
    ['a started session nobody is driving a wall from', { navigationCommits: true, wallDriven: false }, null],
  ];

  it.each(cases)('%s → %j', (_scenario, overrides, expected) => {
    expect(resolveWallPillState({ ...pillBase, ...overrides })).toBe(expected);
  });

  // Both null-ish sides of "displayed equals wall" — an unknown wall must never
  // match an unknown displayed climb into a false "On the wall".
  it('does not read two unknowns as a match', () => {
    expect(resolveWallPillState({ ...pillBase, displayedClimbUuid: null, wallClimbUuid: null })).toBe(null);
  });

  it('suppresses the pill for the anonymous viewer in every state that would otherwise light it', () => {
    const wouldLightThePill: Array<Partial<WallPillStateInput>> = [
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      { browseLatchActive: true },
      { navigationCommits: true, wallDriven: true },
    ];
    for (const overrides of wouldLightThePill) {
      expect(resolveWallPillState({ ...pillBase, ...overrides })).not.toBe(null);
      expect(resolveWallPillState({ ...pillBase, ...overrides, isAnonymous: true })).toBe(null);
    }
  });
});

describe('shouldShowHolderBadge', () => {
  // The same-face-never-twice contract: the pill owns the driver's avatar in the
  // on-wall state, so the lightbulb's holder pip stands down for exactly that
  // state and comes back for every other one.
  it.each([
    ['onWall', false],
    ['live', true],
    ['browsing', true],
    [null, true],
  ] as Array<[WallPillState, boolean]>)('pill %j → holder pip shown: %s', (pillState, expected) => {
    expect(shouldShowHolderBadge(pillState)).toBe(expected);
  });
});

describe('resolveCommitBarModel', () => {
  const cases: Array<[string, Partial<CommitBarModelInput>, Omit<CommitBarModel, 'commitLabel'>]> = [
    [
      'no preview pinned: the row keeps the normal actions',
      {},
      { mode: 'actions', showBackToLive: false, showPutOnWall: false, showConfirm: false },
    ],
    [
      'preview pinned on a climb that is not the head',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB },
      { mode: 'commit', showBackToLive: true, showPutOnWall: true, showConfirm: false },
    ],
    [
      'browsed onto the lit climb: nothing to commit, but Back to live still exits the latch',
      { previewPinned: true, displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      { mode: 'commit', showBackToLive: true, showPutOnWall: false, showConfirm: false },
    ],
    [
      'wrong board: no commit controls under the switch-board overlay',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, boardMismatch: true },
      { mode: 'actions', showBackToLive: false, showPutOnWall: false, showConfirm: false },
    ],
    [
      'anonymous viewer never gets the commit row',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, isAnonymous: true },
      { mode: 'actions', showBackToLive: false, showPutOnWall: false, showConfirm: false },
    ],
    [
      'preview still nominally pinned but the displayed climb is the head again: collapses on its own',
      { previewPinned: true, displayedClimbUuid: MY_CLIMB, committedHeadUuid: MY_CLIMB },
      { mode: 'actions', showBackToLive: false, showPutOnWall: false, showConfirm: false },
    ],
    [
      'confirm armed: the browse pair gives way to the confirm pair',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: MY_CLIMB, confirmArmed: true },
      { mode: 'commit', showBackToLive: false, showPutOnWall: false, showConfirm: true },
    ],
    [
      'confirm armed but the wall now shows the displayed climb: the conflict resolved itself',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: THEIR_CLIMB, confirmArmed: true },
      { mode: 'commit', showBackToLive: true, showPutOnWall: false, showConfirm: false },
    ],
  ];

  it.each(cases)('%s', (_scenario, overrides, expected) => {
    // `commitLabel` is asserted on its own below — these rows are about what the
    // row renders, not which word the filled button wears.
    expect(resolveCommitBarModel({ ...commitBase, ...overrides })).toMatchObject(expected);
  });

  // The commit affordance keys on the pinned preview, NOT the browse latch: a
  // long-press "Preview" with `lightOnSwipe` on has committing swipes (no
  // browsing chrome), but the pinned climb must keep its activation button —
  // the old banner's "Set active" contract. The pill for that same state is
  // asserted `live`/null in the resolveWallPillState tables above.
  it('keeps the commit row for a pinned preview whose swipes still commit', () => {
    const model = resolveCommitBarModel({
      ...commitBase,
      previewPinned: true,
      displayedClimbUuid: THEIR_CLIMB,
    });
    expect(model.mode).toBe('commit');
    expect(model.showPutOnWall).toBe(true);
  });

  // A pinned preview with no head to return to (an anonymous-shaped open for a
  // member, a drawer opened straight onto a preview) still commits —
  // `null !== null` must not be read as "you're already on your head".
  it('keeps the commit row when there is no committed head at all', () => {
    const model = resolveCommitBarModel({
      ...commitBase,
      previewPinned: true,
      displayedClimbUuid: THEIR_CLIMB,
      committedHeadUuid: null,
    });
    expect(model.mode).toBe('commit');
  });

  it('does not collapse the row on two unknown uuids', () => {
    const model = resolveCommitBarModel({
      ...commitBase,
      previewPinned: true,
      displayedClimbUuid: null,
      committedHeadUuid: null,
    });
    expect(model.mode).toBe('commit');
  });

  describe('commit label', () => {
    // The button must never promise a lighting it can't do.
    it.each([
      ['a wall is being driven (this device, or a session peer)', { wallDriven: true }, 'putOnWall'],
      ['a lit climb is known', { wallClimbUuid: THEIR_CLIMB }, 'putOnWall'],
      ['no wall is reachable at all', {}, 'setActive'],
    ] as Array<[string, Partial<CommitBarModelInput>, string]>)('%s → %s', (_scenario, overrides, expected) => {
      const model = resolveCommitBarModel({
        ...commitBase,
        previewPinned: true,
        displayedClimbUuid: THEIR_CLIMB,
        ...overrides,
      });
      expect(model.commitLabel).toBe(expected);
    });
  });
});

describe('shouldArmBusyWallConfirm', () => {
  // Someone moved the wall while you were browsing, and moved it to something
  // other than what you're about to put up.
  const armingCase = {
    wallClimbUuid: THEIR_CLIMB,
    wallUuidAtLatchStart: MY_CLIMB,
    displayedClimbUuid: WALL_CLIMB,
  };

  it('arms when the wall changed under you to a third climb', () => {
    expect(shouldArmBusyWallConfirm(armingCase)).toBe(true);
  });

  // One mutation per clause: each is load-bearing on its own.
  it('does not arm on a dark wall — nobody owns it', () => {
    expect(shouldArmBusyWallConfirm({ ...armingCase, wallClimbUuid: null })).toBe(false);
  });

  it('does not arm when the wall still shows what it showed when browsing started', () => {
    expect(shouldArmBusyWallConfirm({ ...armingCase, wallUuidAtLatchStart: THEIR_CLIMB })).toBe(false);
  });

  it('does not arm when the wall already shows the climb you are committing', () => {
    expect(shouldArmBusyWallConfirm({ ...armingCase, displayedClimbUuid: THEIR_CLIMB })).toBe(false);
  });

  it('arms when the latch started against a dark wall and someone has since lit one', () => {
    expect(shouldArmBusyWallConfirm({ ...armingCase, wallUuidAtLatchStart: null })).toBe(true);
  });
});

// The narration contract, pinned on the TRANSITION rather than on the state the
// pill happens to be showing — because the two sentences that end a browse latch
// ("Back to live: X" / "X is on the wall") land on the same states, and the
// commonest landing is no pill at all.
describe('resolveWallStateAnnouncement', () => {
  const announceBase: WallStateAnnouncementInput = { previous: 'live', next: 'live', exit: null };

  const cases: Array<[string, Partial<WallStateAnnouncementInput>, WallStateAnnouncement]> = [
    // Mount is not a transition: opening the drawer must never narrate a state
    // the climber navigated into deliberately.
    ['first resolve on mount, already browsing', { previous: undefined, next: 'browsing' }, null],
    ['a re-render with no state change', { previous: 'browsing', next: 'browsing' }, null],
    // Entering the latch — including from no pill at all, which is exactly what
    // happens on a plain preview with no wall stakes.
    ['no pill → browsing', { previous: null, next: 'browsing' }, 'browse'],
    ['live → browsing', { previous: 'live', next: 'browsing' }, 'browse'],
    ['on the wall → browsing', { previous: 'onWall', next: 'browsing' }, 'browse'],
    // Leaving it: the words follow HOW you left, not where you landed. Both of
    // these unmount the pill in the commonest (no BLE, no session) case, which is
    // why the announcement can't live inside it.
    ['committed with stakes left', { previous: 'browsing', next: 'onWall', exit: 'commit' }, 'committed'],
    ['committed with no stakes left', { previous: 'browsing', next: null, exit: 'commit' }, 'committed'],
    ['back to live with stakes left', { previous: 'browsing', next: 'live', exit: 'backToLive' }, 'backToLive'],
    ['back to live with no stakes left', { previous: 'browsing', next: null, exit: 'backToLive' }, 'backToLive'],
    // The latch ended for some other reason (an angle change re-deriving the
    // drawer). Nothing was claimed, so nothing is claimed back.
    ['browsing ended without an exit the climber took', { previous: 'browsing', next: null }, null],
    // Transitions that aren't about the latch stay silent: the pill's own label
    // already reads the new state when focus lands on it.
    ['no pill → live', { previous: null, next: 'live' }, null],
    ['live → on the wall', { previous: 'live', next: 'onWall' }, null],
    // A stale exit marker can only speak for a transition OUT of browsing.
    ['live → no pill with a stale commit marker', { previous: 'live', next: null, exit: 'commit' }, null],
  ];

  it.each(cases)('%s → %j', (_scenario, overrides, expected) => {
    expect(resolveWallStateAnnouncement({ ...announceBase, ...overrides })).toBe(expected);
  });
});
