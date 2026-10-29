import { describe, expect, it } from 'vitest';
import {
  canLeavePreview,
  resolveBrowseCaption,
  resolveCommitBarModel,
  resolveCommitButton,
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
  currentDark: false,
  otherBoard: false,
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
  tapConnects: false,
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
    [
      'displayed climb is the lit one',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, wallDriven: true },
      'onWall',
    ],
    [
      'browsed back onto the lit climb mid-latch — on-wall outranks browsing',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, browseLatchActive: true, wallDriven: true },
      'onWall',
    ],
    // #7000 QA: presence names a climb lit hours ago and no link drives the
    // wall, so nobody can vouch for the LEDs.
    [
      'presence names the climb but no link drives the wall',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      null,
    ],
    [
      'a lit wall showing a different climb is not on-wall',
      { displayedClimbUuid: MY_CLIMB, wallClimbUuid: THEIR_CLIMB, navigationCommits: true, wallDriven: true },
      'live',
    ],
    // Rung 2 (#7000) — a dark current climb claims nothing, whatever presence says.
    [
      'the 4 h hold keeps the climb dark while presence still names it',
      {
        displayedClimbUuid: MY_CLIMB,
        wallClimbUuid: MY_CLIMB,
        navigationCommits: true,
        wallDriven: true,
        currentDark: true,
      },
      null,
    ],
    [
      'the 4 h hold keeps the climb dark and presence names nothing',
      { navigationCommits: true, wallDriven: true, currentDark: true },
      null,
    ],
    [
      'lights turned off while the wall still names the climb',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, wallDriven: true, currentDark: true },
      null,
    ],
    [
      'a climb for another board the wall still names',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, wallDriven: true, otherBoard: true },
      null,
    ],
    [
      'a climb for another board on a driven wall is not Live',
      { navigationCommits: true, wallDriven: true, otherBoard: true },
      null,
    ],
    // A latch over a dark climb still says browsing, so the browse announcement fires.
    ['browse latch up over a dark current climb', { browseLatchActive: true, currentDark: true }, 'browsing'],
    [
      'a dark climb presence names as lit beats the latch',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, browseLatchActive: true, currentDark: true },
      null,
    ],
    // Rung 3 — the latch.
    ['browse latch up with no wall known', { browseLatchActive: true }, 'browsing'],
    [
      'browse latch outranks a committing navigation',
      { browseLatchActive: true, navigationCommits: true, wallDriven: true },
      'browsing',
    ],
    // Rung 4 — live needs a wall someone is driving.
    ['committing navigation over a wall someone is driving', { navigationCommits: true, wallDriven: true }, 'live'],
    // With no link the next swipe lights nothing (#7000): a known lit climb is not enough.
    [
      'committing navigation with a known lit climb but no link of our own',
      { navigationCommits: true, wallClimbUuid: THEIR_CLIMB },
      null,
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
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB, wallDriven: true },
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
  // The same-face-never-twice contract: the back chip that goes to the wall
  // wears the driver's avatar, so the bulb's holder pip stands down for it and
  // comes back for the rest. A back chip to the climber's own climb wears no
  // face, so the pip stays.
  it.each([
    ['back chip to the wall', { state: 'browsing', backTarget: 'wall' }, false],
    ['back chip to the climber’s own climb', { state: 'browsing', backTarget: 'current' }, true],
    ['no chip', null, true],
  ] as Array<[string, HeaderPill, boolean]>)('%s → holder pip shown: %s', (_scenario, pill, expected) => {
    expect(shouldShowHolderBadge(pill)).toBe(expected);
  });
});

/** Signed-in climber, a preview pinned over their own head, nothing lit. */
const headerBase: HeaderPillInput = {
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

// #7000: the header carries the back chip and nothing else. The wall button
// says whether the climb on screen is lit, so there is no On the wall or Live.
describe('resolveHeaderPillState', () => {
  const cases: Array<[string, Partial<HeaderPillInput>, HeaderPill]> = [
    ['anonymous viewer mid-preview', { isAnonymous: true }, null],
    // Back lands on the committed climb, which is what's lit.
    ['wall shows the committed climb', { wallClimbUuid: MY_CLIMB }, { state: 'browsing', backTarget: 'wall' }],
    // Back lands on the climber's own climb; the wall shows something else.
    ['wall shows a third climb', { wallClimbUuid: WALL_CLIMB }, { state: 'browsing', backTarget: 'current' }],
    ['wall dark', { wallClimbUuid: null }, { state: 'browsing', backTarget: 'current' }],
    // Previewing the lit climb from elsewhere: the way back stays.
    [
      'previewing the lit climb',
      { displayedClimbUuid: WALL_CLIMB, wallClimbUuid: WALL_CLIMB },
      { state: 'browsing', backTarget: 'current' },
    ],
    // Nowhere to go back to: the sheet empties, so no chip and ⌄ closes.
    ['no committed climb, in the sheet', { committedHeadUuid: null }, null],
    [
      'no committed climb, in the iPad pane',
      { committedHeadUuid: null, wallClimbUuid: WALL_CLIMB, isPane: true },
      { state: 'browsing', backTarget: 'current' },
    ],
    // A two-unknowns wall never reads as "back to the wall".
    [
      'iPad pane, no committed climb and a dark wall',
      { committedHeadUuid: null, wallClimbUuid: null, isPane: true },
      { state: 'browsing', backTarget: 'current' },
    ],
    // Displayed is the head, or no preview: back goes nowhere, and nothing else is drawn.
    ['preview on the committed climb', { displayedClimbUuid: MY_CLIMB }, null],
    [
      'no preview, on the lit climb',
      { previewPinned: false, displayedClimbUuid: MY_CLIMB, wallClimbUuid: MY_CLIMB },
      null,
    ],
  ];

  it.each(cases)('%s → %j', (_scenario, overrides, expected) => {
    expect(resolveHeaderPillState({ ...headerBase, ...overrides })).toEqual(expected);
  });

  // The chip and the explainer's Back to live used to share one rule; now the
  // chip is the only way back, and it shows exactly when back lands somewhere.
  // Over every combination, nothing but the back chip is ever drawn.
  it('draws the back chip exactly when canLeavePreview holds, and nothing else, over every combination', () => {
    const climbs: Array<string | null> = [MY_CLIMB, WALL_CLIMB, THEIR_CLIMB, null];
    let combinations = 0;
    for (const committedHeadUuid of climbs) {
      for (const displayedClimbUuid of climbs) {
        for (const wallClimbUuid of climbs) {
          for (const previewPinned of [true, false]) {
            for (const isPane of [true, false]) {
              for (const isAnonymous of [true, false]) {
                const input: HeaderPillInput = {
                  committedHeadUuid,
                  displayedClimbUuid,
                  wallClimbUuid,
                  previewPinned,
                  isPane,
                  isAnonymous,
                };
                const pill = resolveHeaderPillState(input);
                combinations += 1;
                expect(pill === null || pill.state === 'browsing').toBe(true);
                expect(pill !== null).toBe(canLeavePreview(input));
              }
            }
          }
        }
      }
    }
    expect(combinations).toBe(512);
  });
});

describe('resolveCommitBarModel', () => {
  const cases: Array<[string, Partial<CommitBarModelInput>, Omit<CommitBarModel, 'commitLabel' | 'connectsOnCommit'>]> =
    [
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

// #6939: with no board connected, Put on the wall is how a first-timer gets
// the climb onto the wall, so it shows instead of leaving only a grey bulb, and
// its tap connects.
describe('resolveCommitBarModel with no board connected', () => {
  const disconnected = { ...commitBase, tapConnects: true };

  // #7000: the wall button's Connect board lights your own climb, so there is
  // no Put on the wall for it.
  it('offers nothing to commit on your own current climb', () => {
    expect(resolveCommitBarModel(disconnected)).toEqual({
      mode: 'actions',
      showPutOnWall: false,
      showConfirm: false,
      commitLabel: 'putOnWall',
      connectsOnCommit: false,
    });
  });

  it('labels a preview Put on the wall, not Set active, and connects after setting it', () => {
    const model = resolveCommitBarModel({ ...disconnected, previewPinned: true, displayedClimbUuid: THEIR_CLIMB });
    expect(model).toMatchObject({
      mode: 'commit',
      showPutOnWall: true,
      commitLabel: 'putOnWall',
      connectsOnCommit: true,
    });
  });

  it('offers a preview of the climb presence names as lit (#7000): with no link nobody can see the LEDs', () => {
    const model = resolveCommitBarModel({
      ...disconnected,
      previewPinned: true,
      displayedClimbUuid: THEIR_CLIMB,
      wallClimbUuid: THEIR_CLIMB,
    });
    expect(model.showPutOnWall).toBe(true);
  });

  it.each([
    ['a wall is driven (the tap would not connect anyway)', { wallDriven: true }],
    ['the viewer is anonymous', { isAnonymous: true }],
    ['the climb is on another board', { boardMismatch: true }],
    ['there is no current climb', { committedHeadUuid: null }],
  ] as Array<[string, Partial<CommitBarModelInput>]>)(
    'stays off on the current climb when %s',
    (_scenario, overrides) => {
      const model = resolveCommitBarModel({ ...disconnected, ...overrides });
      expect(model.showPutOnWall).toBe(false);
      expect(model.connectsOnCommit).toBe(false);
    },
  );

  it('keeps Set active where a tap cannot connect (a wall with no lights, a peer holding it)', () => {
    const model = resolveCommitBarModel({ ...commitBase, previewPinned: true, displayedClimbUuid: THEIR_CLIMB });
    expect(model).toMatchObject({ showPutOnWall: true, commitLabel: 'setActive', connectsOnCommit: false });
  });

  it('a driven wall commits without connecting', () => {
    const model = resolveCommitBarModel({
      ...disconnected,
      wallDriven: true,
      previewPinned: true,
      displayedClimbUuid: THEIR_CLIMB,
    });
    expect(model).toMatchObject({ commitLabel: 'putOnWall', connectsOnCommit: false });
  });
});

describe('resolveCommitButton', () => {
  const model = (overrides: Partial<CommitBarModel>): CommitBarModel => ({
    mode: 'actions',
    showPutOnWall: false,
    showConfirm: false,
    commitLabel: 'putOnWall',
    connectsOnCommit: false,
    ...overrides,
  });

  // Put on the wall (a wall button state) for previews and crew browsing only;
  // on your own climb, dark or with no board, the wall button lights it.
  it.each([
    ['nothing to commit', model({}), null],
    ['the busy-wall question wins', model({ mode: 'commit', showConfirm: true }), 'confirm'],
    ['a preview’s Put on the wall', model({ mode: 'commit', showPutOnWall: true }), 'putOnWall'],
    ['previewing the lit climb: nothing to put up', model({ mode: 'commit', showPutOnWall: false }), null],
    ['an actions-mode model never offers it', model({ showPutOnWall: true }), null],
  ] as Array<[string, CommitBarModel, string | null]>)('%s', (_scenario, commitModel, expected) => {
    expect(resolveCommitButton(commitModel)).toBe(expected);
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
