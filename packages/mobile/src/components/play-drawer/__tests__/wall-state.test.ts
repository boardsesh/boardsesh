import { describe, expect, it } from 'vitest';
import {
  canLeavePreview,
  resolveBrowseCaption,
  resolveCommitBarModel,
  resolveHeaderPillState,
  resolveWallPillState,
  resolveWallStateAnnouncement,
  shouldAdoptLateWallRead,
  shouldArmBusyWallConfirm,
  shouldShowHolderBadge,
  WALL_READ_PRE_LATCH_TOLERANCE_MS,
  type BrowseCaption,
  type BrowseCaptionInput,
  type CommitBarModel,
  type CommitBarModelInput,
  type HeaderPill,
  type HeaderPillInput,
  type WallPillState,
  type WallPillStateInput,
  type LateWallReadInput,
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
  // on-wall state and on the back chip that goes to the wall, so the lightbulb's
  // holder pip stands down for exactly those two and comes back for the rest. A
  // back chip to the climber's own climb wears no face, so the pip stays.
  it.each([
    ['on the wall', { state: 'onWall', backTarget: null }, false],
    ['live', { state: 'live', backTarget: null }, true],
    ['back chip to the wall', { state: 'browsing', backTarget: 'wall' }, false],
    ['back chip to the climber’s own climb', { state: 'browsing', backTarget: 'current' }, true],
    ['no chip', null, true],
  ] as Array<[string, HeaderPill, boolean]>)('%s → holder pip shown: %s', (_scenario, pill, expected) => {
    expect(shouldShowHolderBadge(pill)).toBe(expected);
  });
});

/** Signed-in climber, a preview pinned over their own head, nothing lit. */
const headerBase: HeaderPillInput = {
  wallPillState: null,
  previewPinned: true,
  isAnonymous: false,
  displayedClimbUuid: THEIR_CLIMB,
  committedHeadUuid: MY_CLIMB,
  wallClimbUuid: null,
  isPane: false,
};

describe('canLeavePreview', () => {
  const cases: Array<[string, Partial<HeaderPillInput>, boolean]> = [
    ['a preview pinned over a different committed climb', {}, true],
    ['no preview pinned', { previewPinned: false }, false],
    ['anonymous viewer', { isAnonymous: true }, false],
    ['the preview is the committed climb itself', { displayedClimbUuid: MY_CLIMB }, false],
    // Going back would empty the sheet; ⌄ closes it instead.
    ['no committed climb, in the sheet', { committedHeadUuid: null }, false],
    // The iPad pane has no ⌄, and its empty placeholder is somewhere to land.
    ['no committed climb, in the iPad pane', { committedHeadUuid: null, isPane: true }, true],
    [
      'no committed climb and nothing displayed, in the iPad pane',
      { committedHeadUuid: null, displayedClimbUuid: null, isPane: true },
      true,
    ],
    [
      'the iPad pane still needs a preview pinned',
      { committedHeadUuid: null, isPane: true, previewPinned: false },
      false,
    ],
    ['the iPad pane is no way round anonymity', { committedHeadUuid: null, isPane: true, isAnonymous: true }, false],
  ];

  it.each(cases)('%s → %s', (_scenario, overrides, expected) => {
    expect(canLeavePreview({ ...headerBase, ...overrides })).toBe(expected);
  });
});

describe('resolveHeaderPillState', () => {
  const cases: Array<[string, Partial<HeaderPillInput>, HeaderPill]> = [
    // The read-only viewer never gets wall chrome.
    [
      'anonymous viewer on the lit climb',
      { isAnonymous: true, wallPillState: 'onWall', displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      null,
    ],
    ['anonymous viewer mid-preview', { isAnonymous: true, wallPillState: 'browsing' }, null],
    // On the wall stays: its chip opens the explainer, it isn't a way back.
    [
      'on the wall, even with a preview pinned',
      { wallPillState: 'onWall', displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      { state: 'onWall', backTarget: null },
    ],
    [
      'on the wall, no preview pinned',
      { wallPillState: 'onWall', previewPinned: false, displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      { state: 'onWall', backTarget: null },
    ],
    // A crew latch: back lands on the head, which is what's lit.
    [
      'crew latch, wall shows the committed climb',
      { wallPillState: 'browsing', wallClimbUuid: MY_CLIMB },
      { state: 'browsing', backTarget: 'wall' },
    ],
    // Back lands on the climber's own climb; the wall shows something else.
    [
      'crew latch, wall shows a third climb',
      { wallPillState: 'browsing', wallClimbUuid: WALL_CLIMB },
      { state: 'browsing', backTarget: 'current' },
    ],
    [
      'crew latch, wall dark',
      { wallPillState: 'browsing', wallClimbUuid: null },
      { state: 'browsing', backTarget: 'current' },
    ],
    // Nowhere to go back to: the sheet empties, so no chip and ⌄ closes.
    ['crew latch with no committed climb, in the sheet', { wallPillState: 'browsing', committedHeadUuid: null }, null],
    [
      'crew latch with no committed climb, in the iPad pane',
      { wallPillState: 'browsing', committedHeadUuid: null, wallClimbUuid: WALL_CLIMB, isPane: true },
      { state: 'browsing', backTarget: 'current' },
    ],
    // A two-unknowns wall never reads as "back to the wall".
    [
      'iPad pane, no committed climb and a dark wall',
      { wallPillState: 'browsing', committedHeadUuid: null, wallClimbUuid: null, isPane: true },
      { state: 'browsing', backTarget: 'current' },
    ],
    // A solo preview with lighting on: Live used to stand here and the way back
    // sat in the second row. The back chip takes both jobs now.
    [
      'solo preview with lighting on (live) and a committed climb',
      { wallPillState: 'live', wallClimbUuid: MY_CLIMB },
      { state: 'browsing', backTarget: 'wall' },
    ],
    [
      'solo preview with lighting on (live), wall elsewhere',
      { wallPillState: 'live', wallClimbUuid: WALL_CLIMB },
      { state: 'browsing', backTarget: 'current' },
    ],
    // A plain preview with no stakes had no chip at all; now back has one.
    [
      'solo preview with no stakes (no pill) and a committed climb',
      { wallPillState: null },
      { state: 'browsing', backTarget: 'current' },
    ],
    // Displayed is the head: back goes nowhere, so the pill underneath stands.
    ['preview on the committed climb, no pill', { wallPillState: null, displayedClimbUuid: MY_CLIMB }, null],
    [
      'preview on the committed climb, live',
      { wallPillState: 'live', displayedClimbUuid: MY_CLIMB },
      { state: 'live', backTarget: null },
    ],
    ['preview on the committed climb, latched', { wallPillState: 'browsing', displayedClimbUuid: MY_CLIMB }, null],
    // No preview: Live and nothing pass straight through.
    [
      'no preview, live',
      { wallPillState: 'live', previewPinned: false, displayedClimbUuid: MY_CLIMB },
      { state: 'live', backTarget: null },
    ],
    ['no preview, no pill', { wallPillState: null, previewPinned: false, displayedClimbUuid: MY_CLIMB }, null],
  ];

  it.each(cases)('%s → %j', (_scenario, overrides, expected) => {
    expect(resolveHeaderPillState({ ...headerBase, ...overrides })).toEqual(expected);
  });

  // The chip and the explainer's Back to live share one rule: the chip is a way
  // back exactly when `canLeavePreview` says back lands somewhere.
  it('draws the back chip exactly when canLeavePreview holds (outside On the wall)', () => {
    const pillStates: WallPillState[] = ['live', 'browsing', null];
    const heads: Array<string | null> = [MY_CLIMB, null];
    const displayed: Array<string | null> = [MY_CLIMB, THEIR_CLIMB, null];
    for (const wallPillState of pillStates) {
      for (const committedHeadUuid of heads) {
        for (const displayedClimbUuid of displayed) {
          for (const previewPinned of [true, false]) {
            for (const isPane of [true, false]) {
              const input: HeaderPillInput = {
                ...headerBase,
                wallPillState,
                committedHeadUuid,
                displayedClimbUuid,
                previewPinned,
                isPane,
              };
              expect(resolveHeaderPillState(input)?.state === 'browsing').toBe(canLeavePreview(input));
            }
          }
        }
      }
    }
  });
});

describe('resolveCommitBarModel', () => {
  const cases: Array<[string, Partial<CommitBarModelInput>, Omit<CommitBarModel, 'commitLabel'>]> = [
    [
      'no preview pinned: the row keeps the normal actions',
      {},
      { mode: 'actions', showPutOnWall: false, showConfirm: false },
    ],
    [
      'preview pinned on a climb that is not the head',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB },
      { mode: 'commit', showPutOnWall: true, showConfirm: false },
    ],
    [
      'browsed onto the lit climb: nothing to put up, so no button; the header chip still exits the latch',
      { previewPinned: true, displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      { mode: 'commit', showPutOnWall: false, showConfirm: false },
    ],
    [
      'wrong board: no commit controls under the switch-board overlay',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, boardMismatch: true },
      { mode: 'actions', showPutOnWall: false, showConfirm: false },
    ],
    [
      'anonymous viewer never gets the commit row',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, isAnonymous: true },
      { mode: 'actions', showPutOnWall: false, showConfirm: false },
    ],
    [
      'preview still nominally pinned but the displayed climb is the head again: collapses on its own',
      { previewPinned: true, displayedClimbUuid: MY_CLIMB, committedHeadUuid: MY_CLIMB },
      { mode: 'actions', showPutOnWall: false, showConfirm: false },
    ],
    [
      'confirm armed: Put on the wall gives way to the busy-wall question',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: MY_CLIMB, confirmArmed: true },
      { mode: 'commit', showPutOnWall: false, showConfirm: true },
    ],
    [
      'confirm armed but the wall now shows the displayed climb: the conflict resolved itself',
      { previewPinned: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: THEIR_CLIMB, confirmArmed: true },
      { mode: 'commit', showPutOnWall: false, showConfirm: false },
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

// Telling "the feed hadn't delivered yet" from "the wall was dark". Both read as
// a null snapshot, and the difference decides whether the first commit tap
// accuses a peer of something they didn't do.
describe('shouldAdoptLateWallRead', () => {
  const LATCH_STARTED_AT = Date.parse('2026-08-21T10:00:00Z');
  const lit = (offsetMs: number) => new Date(LATCH_STARTED_AT + offsetMs).toISOString();

  /** The cold-start case: nothing known at latch start, then a long-lit climb lands. */
  const lateReadCase: LateWallReadInput = {
    wallUuidAtLatchStart: null,
    wallClimbUuid: WALL_CLIMB,
    wallClimbSentAt: lit(-10 * 60_000),
    latchStartedAt: LATCH_STARTED_AT,
  };

  it('adopts a climb that was lit long before this browse began', () => {
    expect(shouldAdoptLateWallRead(lateReadCase)).toBe(true);
  });

  // Each clause on its own — and every one of them fails SAFE, leaving the
  // confirm free to arm.
  it('leaves a snapshot that already read the wall alone', () => {
    expect(shouldAdoptLateWallRead({ ...lateReadCase, wallUuidAtLatchStart: THEIR_CLIMB })).toBe(false);
  });

  it('has nothing to adopt while the wall is still dark', () => {
    expect(shouldAdoptLateWallRead({ ...lateReadCase, wallClimbUuid: null })).toBe(false);
  });

  it('arms rather than guesses when the lighting carries no timestamp', () => {
    expect(shouldAdoptLateWallRead({ ...lateReadCase, wallClimbSentAt: null })).toBe(false);
    expect(shouldAdoptLateWallRead({ ...lateReadCase, wallClimbSentAt: 'not a date' })).toBe(false);
  });

  it('arms rather than guesses before any latch has started', () => {
    expect(shouldAdoptLateWallRead({ ...lateReadCase, latchStartedAt: null })).toBe(false);
  });

  it('never adopts a climb lit DURING the browse — that is the peer this protects', () => {
    expect(shouldAdoptLateWallRead({ ...lateReadCase, wallClimbSentAt: lit(1_000) })).toBe(false);
  });

  // The tolerance is the clock-skew allowance: the wall's timestamp comes from
  // the server and the latch's from this phone, so "just before" is not evidence
  // of anything.
  it('treats a lighting inside the skew tolerance as too recent to adopt', () => {
    const insideTolerance = lit(-(WALL_READ_PRE_LATCH_TOLERANCE_MS - 1_000));
    expect(shouldAdoptLateWallRead({ ...lateReadCase, wallClimbSentAt: insideTolerance })).toBe(false);
  });

  it('adopts once the lighting is older than the tolerance', () => {
    const outsideTolerance = lit(-(WALL_READ_PRE_LATCH_TOLERANCE_MS + 1_000));
    expect(shouldAdoptLateWallRead({ ...lateReadCase, wallClimbSentAt: outsideTolerance })).toBe(true);
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

describe('resolveBrowseCaption', () => {
  /** Solo, previewing someone else's climb while a board is connected and the wall shows yours. */
  const captionBase: BrowseCaptionInput = {
    isAnonymous: false,
    isPreview: true,
    climbUuid: THEIR_CLIMB,
    committedHeadUuid: MY_CLIMB,
    wallClimbUuid: MY_CLIMB,
    wallClimbName: 'Crimp Ladder',
    inCrew: false,
    wallDriven: true,
  };
  const cases: Array<[string, Partial<BrowseCaptionInput>, BrowseCaption]> = [
    // Confusion 1: Light on tap off opened a preview, and nothing said it was not lit.
    ['solo preview while a board is connected', {}, { kind: 'preview' }],
    ['solo preview, board connected, wall dark', { wallClimbUuid: null }, { kind: 'preview' }],
    ['solo preview, nothing connected but a climb is lit', { wallDriven: false }, { kind: 'preview' }],
    // No board and nothing lit: "not lit" is about something the climber hasn't got.
    ['solo preview with no board and nothing lit', { wallDriven: false, wallClimbUuid: null }, null],
    // Confusion 4: in a crew, say the look is private and what the room has up.
    ['crew preview, the room has a climb lit', { inCrew: true }, { kind: 'crew', wallClimbName: 'Crimp Ladder' }],
    ['crew preview, wall dark', { inCrew: true, wallClimbUuid: null }, { kind: 'crew', wallClimbName: null }],
    [
      'crew preview, nothing connected locally: still private',
      { inCrew: true, wallDriven: false, wallClimbUuid: null },
      { kind: 'crew', wallClimbName: null },
    ],
    [
      'crew preview, lit climb with no name yet',
      { inCrew: true, wallClimbName: null },
      { kind: 'crew', wallClimbName: null },
    ],
    // Nothing to say.
    ['the preview is the lit climb', { climbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB }, null],
    ['the crew preview is the lit climb', { inCrew: true, climbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB }, null],
    ["previewing the climber's own current climb", { climbUuid: MY_CLIMB, wallClimbUuid: WALL_CLIMB }, null],
    ['not a preview', { isPreview: false }, null],
    ['not a preview, in a crew', { isPreview: false, inCrew: true }, null],
    ['no climb on screen', { climbUuid: null }, null],
    ['anonymous viewer', { isAnonymous: true, inCrew: true }, null],
  ];

  it.each(cases)('%s', (_scenario, overrides, expected) => {
    expect(resolveBrowseCaption({ ...captionBase, ...overrides })).toEqual(expected);
  });
});
