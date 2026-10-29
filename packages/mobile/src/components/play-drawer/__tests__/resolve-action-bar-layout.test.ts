import { describe, expect, it } from 'vitest';
import { resolveActionBarLayout, type ActionBarLayoutInput } from '../action-bar-layout';
import { DEFAULT_PLAYER_BUTTONS, type PlayerButtonId, type PlayerButtonsLayout } from '../../../lib/player-buttons';

const MEMBER: ActionBarLayoutInput = {
  supportsMirroring: false,
  isAnonymous: false,
  commitButton: null,
  workoutOutcome: false,
  showLightbulb: true,
  hasShare: true,
  angleAvailable: true,
  buttons: DEFAULT_PLAYER_BUTTONS,
  previousNext: true,
};
const MIRROR: ActionBarLayoutInput = { ...MEMBER, supportsMirroring: true };
const NOTHING_HIDDEN = { tick: false, favorite: false, share: false, queue: false, mirror: false, angle: false };
const BULB: Partial<ActionBarLayoutInput> = { boardControl: 'lightbulb' };

/** The default switches, with the listed buttons switched off. */
function off(...buttonIds: PlayerButtonId[]): PlayerButtonsLayout {
  const visible = { ...DEFAULT_PLAYER_BUTTONS.visible };
  for (const buttonId of buttonIds) visible[buttonId] = false;
  return { order: DEFAULT_PLAYER_BUTTONS.order, visible };
}

// #7000: one wall button fills the second row on every board, in every wall
// state, so nothing moves; the first row's ends are fixed per board.
describe('resolveActionBarLayout: the bars', () => {
  // [♡] [⏮] [✓] [⏭] [☰] / [ wall button ]
  it('leads with the heart on a board that cannot mirror', () => {
    expect(resolveActionBarLayout(MEMBER)).toEqual({
      primaryCenter: 'tick',
      leadingSlot: 'favorite',
      trailingSlot: 'queue',
      showPreviousNext: true,
      secondaryRow: ['wallControl'],
      hidden: { ...NOTHING_HIDDEN, share: true, angle: true },
    });
  });

  // [⇄] [⏮] [✓] [⏭] [☰] / [ wall button ]  (♡ in ⋯)
  it('keeps Mirror first on a board that mirrors, and the heart lives in ⋯ only', () => {
    expect(resolveActionBarLayout(MIRROR)).toEqual({
      primaryCenter: 'tick',
      leadingSlot: 'mirror',
      trailingSlot: 'queue',
      showPreviousNext: true,
      secondaryRow: ['wallControl'],
      hidden: { ...NOTHING_HIDDEN, favorite: true, share: true, angle: true },
    });
  });

  it.each([
    ['no board, a preview, lit, a crew', { commitButton: null }],
    ['a preview (Put on the wall is a wall button state)', { commitButton: 'putOnWall' as const }],
    ['a preview in a timed block', { commitButton: 'putOnWall' as const, workoutOutcome: true }],
  ])('draws the wall button alone, full width, for %s', (_state, input) => {
    for (const board of [MEMBER, MIRROR]) {
      const layout = resolveActionBarLayout({ ...board, ...input });
      expect(layout.secondaryRow).toEqual(['wallControl']);
      expect(layout.trailingSlot).toBe('queue');
    }
  });

  it('shares and changes the angle from ⋯ only, wherever they could draw', () => {
    const layout = resolveActionBarLayout(MIRROR);
    expect(layout.hidden.share).toBe(true);
    expect(layout.hidden.angle).toBe(true);
    // A draft has no link and a fixed-angle board no angle sheet, so ⋯ has no row for them.
    const nothingToOffer = resolveActionBarLayout({ ...MIRROR, hasShare: false, angleAvailable: false });
    expect(nothingToOffer.hidden.share).toBe(false);
    expect(nothingToOffer.hidden.angle).toBe(false);
  });

  it('leaves both ⏮ ⏭ slots empty with Previous and next off', () => {
    expect(resolveActionBarLayout({ ...MEMBER, previousNext: false }).showPreviousNext).toBe(false);
  });
});

// The wall button goes with the second row, so the bulb comes back: a link
// that drops mid-workout can still be reconnected, and the sheet still opens.
describe('resolveActionBarLayout: the row the wall button gives up', () => {
  it.each([
    ['the busy-wall question with the bulb chosen', { commitButton: 'confirm' as const, ...BULB }, 'confirm'],
    ['Fell / Sent with the bulb chosen', { workoutOutcome: true, ...BULB }, 'workoutOutcome'],
  ])('keeps the bulb in the first row under %s, the queue stepping into ⋯', (_row, input, row) => {
    for (const board of [MEMBER, MIRROR]) {
      const layout = resolveActionBarLayout({ ...board, ...input });
      expect(layout.primaryCenter).toBe('tick');
      expect(layout.secondaryRow).toBe(row);
      expect(layout.trailingSlot).toBe('lightbulb');
      expect(layout.hidden.queue).toBe(true);
      // The leading slot never moves with the wall state.
      expect(layout.leadingSlot).toBe(board.supportsMirroring ? 'mirror' : 'favorite');
    }
  });

  it('keeps the queue in the slot where there is no Bluetooth to reconnect', () => {
    const layout = resolveActionBarLayout({ ...MEMBER, workoutOutcome: true, showLightbulb: false });
    expect(layout.trailingSlot).toBe('queue');
    expect(layout.hidden.queue).toBe(false);
  });
});

const PLAYER_ORDER = ['mirror', 'favorite', 'queue', 'share', 'angle'] as const;

/** A layout in the given order, with the listed buttons switched on and the rest off. */
function layout(order: readonly PlayerButtonId[], on: readonly PlayerButtonId[]): PlayerButtonsLayout {
  const visible = { mirror: false, favorite: false, queue: false, share: false, angle: false };
  for (const buttonId of on) visible[buttonId] = true;
  return { order, visible };
}

// The climber's buttons fill the first row's two ends: the first on that
// applies here takes the leading slot, the last the trailing one, the rest ⋯.
// Every case runs on both board kinds, plain and under the busy-wall question
// and Fell / Sent, which hand the trailing slot to the bulb.
describe('resolveActionBarLayout: the climber’s buttons', () => {
  type Ends = [PlayerButtonId | null, PlayerButtonId | null];
  type Row = [string, PlayerButtonsLayout, Ends, Ends];
  const rows: Row[] = [
    ['the defaults', DEFAULT_PLAYER_BUTTONS, ['mirror', 'queue'], ['favorite', 'queue']],
    [
      'Share moved first and on',
      layout(['share', 'mirror', 'favorite', 'queue', 'angle'], ['share', 'mirror', 'favorite', 'queue']),
      ['share', 'queue'],
      ['share', 'queue'],
    ],
    [
      'Angle last and on',
      layout(['mirror', 'favorite', 'queue', 'share', 'angle'], ['mirror', 'favorite', 'angle']),
      ['mirror', 'angle'],
      ['favorite', 'angle'],
    ],
    [
      'the queue alone',
      layout(['mirror', 'favorite', 'queue', 'share', 'angle'], ['queue']),
      ['queue', null],
      ['queue', null],
    ],
    [
      'Mirror alone (it applies only where the board mirrors)',
      layout(['mirror', 'favorite', 'queue', 'share', 'angle'], ['mirror']),
      ['mirror', null],
      [null, null],
    ],
    ['everything off', layout(['mirror', 'favorite', 'queue', 'share', 'angle'], []), [null, null], [null, null]],
  ];

  it.each(rows)('%s', (_case, buttons, [mirrorLead, mirrorTrail], [plainLead, plainTrail]) => {
    for (const [board, lead, trail] of [
      [MIRROR, mirrorLead, mirrorTrail],
      [MEMBER, plainLead, plainTrail],
    ] as const) {
      const plain = resolveActionBarLayout({ ...board, buttons });
      expect(plain.leadingSlot).toBe(lead);
      expect(plain.trailingSlot).toBe(trail);
      expect(plain.secondaryRow).toEqual(['wallControl']);
      // ⋯ carries every button that applies here and is not drawn.
      for (const buttonId of ['mirror', 'favorite', 'queue', 'share', 'angle'] as const) {
        const applies = buttonId !== 'mirror' || board.supportsMirroring;
        expect(plain.hidden[buttonId]).toBe(applies && lead !== buttonId && trail !== buttonId);
      }

      for (const overlay of [
        { commitButton: 'confirm' as const, ...BULB },
        { workoutOutcome: true, ...BULB },
      ]) {
        const taken = resolveActionBarLayout({ ...board, buttons, ...overlay });
        expect(taken.leadingSlot).toBe(lead);
        expect(taken.trailingSlot).toBe('lightbulb');
        if (trail !== null) expect(taken.hidden[trail]).toBe(true);
      }

      // Fell / Sent with the wall button: ⏮ [wall button] ⏭, everything else in ⋯.
      const block = resolveActionBarLayout({ ...board, buttons, workoutOutcome: true });
      expect(block.primaryCenter).toBe('wallControl');
      expect([block.leadingSlot, block.trailingSlot]).toEqual([null, null]);
      expect(block.hidden.tick).toBe(true);
      for (const buttonId of ['favorite', 'queue'] as const) expect(block.hidden[buttonId]).toBe(true);

      // The busy-wall question with the wall button (#7017): the first row is
      // untouched, ends and all; the pair replaces the wall button below it.
      for (const overlay of [
        { commitButton: 'confirm' as const },
        { commitButton: 'confirm' as const, workoutOutcome: true },
      ]) {
        const asked = resolveActionBarLayout({ ...board, buttons, ...overlay });
        expect(asked.primaryCenter).toBe('tick');
        expect([asked.leadingSlot, asked.trailingSlot]).toEqual([lead, trail]);
        expect(asked.secondaryRow).toBe('confirm');
        expect(asked.hidden).toEqual(plain.hidden);
      }
    }
  });

  it('gives Angle no slot on a board whose angle is fixed, and ⋯ no row for it', () => {
    const angleLast = layout(['mirror', 'favorite', 'queue', 'share', 'angle'], ['favorite', 'angle']);
    const fixed = resolveActionBarLayout({ ...MEMBER, buttons: angleLast, angleAvailable: false });
    expect(fixed.leadingSlot).toBe('favorite');
    expect(fixed.trailingSlot).toBeNull();
    expect(fixed.hidden.angle).toBe(false);
  });

  it('keeps Share’s slot on a draft, empty, so nothing jumps between climbs', () => {
    const shareLast = layout(['mirror', 'favorite', 'queue', 'share', 'angle'], ['favorite', 'share']);
    const draft = resolveActionBarLayout({ ...MEMBER, buttons: shareLast, hasShare: false });
    expect(draft.trailingSlot).toBe('share');
    expect(draft.hidden.share).toBe(false);
  });

  it('defaults to Marco’s bar, Share and Angle in ⋯', () => {
    expect(DEFAULT_PLAYER_BUTTONS.order).toEqual(['mirror', 'favorite', 'queue', 'share', 'angle']);
    expect(DEFAULT_PLAYER_BUTTONS.visible).toEqual({
      mirror: true,
      favorite: true,
      queue: true,
      share: false,
      angle: false,
    });
  });
});

// #7000: View options › Buttons › Board control. One model behind both looks;
// only where the control sits changes. Mode × board × the wall's moment.
describe('resolveActionBarLayout: the board control choice', () => {
  type Moment = [string, Partial<ActionBarLayoutInput>];
  const moments: Moment[] = [
    ['nothing asked', {}],
    ['a preview', { commitButton: 'putOnWall' }],
    ['the busy-wall question', { commitButton: 'confirm' }],
    ['Fell / Sent', { workoutOutcome: true }],
    ['the busy-wall question in a block', { commitButton: 'confirm', workoutOutcome: true }],
  ];
  // [mode, moment] → [primaryCenter, trailing slot, second row on a mirror board, on another board]
  type Expected = [string, string | null, unknown, unknown];
  const expected: Record<string, Record<string, Expected | ((board: 'mirror' | 'plain') => Expected)>> = {
    wallButton: {
      'nothing asked': ['tick', 'queue', ['wallControl'], ['wallControl']],
      'a preview': ['tick', 'queue', ['wallControl'], ['wallControl']],
      // #7017: the first row stays as it was, and the pair takes the wall
      // button's row. Put mine up carries the bulb, so the bulb never comes back.
      'the busy-wall question': ['tick', 'queue', 'confirm', 'confirm'],
      'Fell / Sent': ['wallControl', null, 'workoutOutcome', 'workoutOutcome'],
      'the busy-wall question in a block': ['tick', 'queue', 'confirm', 'confirm'],
    },
    lightbulb: {
      // The row stays, so the board never jumps: ♡ left and ☰ right on a mirror
      // board (⇄ leads), ☰ alone on the left of another (♡ leads).
      'nothing asked': ['tick', 'lightbulb', ['favorite', 'spacer', 'queue'], ['queue', 'spacer']],
      // Put on the wall takes the gap, and pushes nothing into ⋯.
      'a preview': ['tick', 'lightbulb', ['favorite', 'wallControl', 'queue'], ['queue', 'wallControl']],
      'the busy-wall question': ['tick', 'lightbulb', 'confirm', 'confirm'],
      'Fell / Sent': ['tick', 'lightbulb', 'workoutOutcome', 'workoutOutcome'],
      'the busy-wall question in a block': ['tick', 'lightbulb', 'confirm', 'confirm'],
    },
  };

  it.each(
    (['wallButton', 'lightbulb'] as const).flatMap((mode) =>
      moments.map(([moment, input]) => [mode, moment, input] as const),
    ),
  )('%s, %s', (mode, moment, input) => {
    const [center, trailing, mirrorRow, plainRow] = expected[mode][moment] as Expected;
    for (const board of [MIRROR, MEMBER]) {
      const layout = resolveActionBarLayout({ ...board, ...input, boardControl: mode });
      expect(layout.primaryCenter).toBe(center);
      expect(layout.secondaryRow).toEqual(board.supportsMirroring ? mirrorRow : plainRow);
      // The bulb or the wall button replaces the climber's last button; Mirror
      // leads where the board mirrors, the heart where it doesn't.
      expect(layout.trailingSlot).toBe(trailing);
      if (center === 'tick') expect(layout.leadingSlot).toBe(board.supportsMirroring ? 'mirror' : 'favorite');
    }
  });

  it('draws every button on with the bulb, so ⋯ has none to stand in for: ⇄ ⏮ ✓ ⏭ 💡 / ♡ ··· ☰', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, ...BULB });
    expect([layout.leadingSlot, layout.trailingSlot]).toEqual(['mirror', 'lightbulb']);
    expect(layout.hidden).toMatchObject({ favorite: false, queue: false, mirror: false, tick: false });
    // Share and Angle are off by default, so ⋯ still offers them.
    expect(layout.hidden).toMatchObject({ share: true, angle: true });
    // Under the busy-wall question or Fell / Sent the side buttons step into ⋯.
    expect(resolveActionBarLayout({ ...MIRROR, ...BULB, workoutOutcome: true }).hidden).toMatchObject({
      favorite: true,
      queue: true,
    });
  });

  it('splits the side buttons, the first half left of the gap', () => {
    const all = layout(
      ['mirror', 'favorite', 'queue', 'share', 'angle'],
      ['mirror', 'favorite', 'queue', 'share', 'angle'],
    );
    expect(resolveActionBarLayout({ ...MIRROR, ...BULB, buttons: all }).secondaryRow).toEqual([
      'favorite',
      'queue',
      'spacer',
      'share',
      'angle',
    ]);
    // Only the leading button on: the row is the gap alone, kept for the board's size.
    expect(
      resolveActionBarLayout({ ...MIRROR, ...BULB, buttons: layout(PLAYER_ORDER, ['mirror']) }).secondaryRow,
    ).toEqual(['spacer']);
  });

  it('gives the bulb no slot with no wall to light, and folds the row', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, ...BULB, hasWall: false });
    expect(layout.trailingSlot).toBe('queue');
    expect(layout.secondaryRow).toEqual([]);
  });

  it('keeps Log in a block with no Bluetooth, where the wall button would have nothing to say', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, workoutOutcome: true, showLightbulb: false });
    expect(layout.primaryCenter).toBe('tick');
    expect(layout.hidden.tick).toBe(false);
  });
});

// #7000, the tablet rule: beside a MiniPlayer that stands in for the first row
// (the open Duo's pane, a tablet's player route) the wall button moves up into
// it, full width; the second row is only the busy-wall question or Fell / Sent.
describe('resolveActionBarLayout: beside a MiniPlayer (tablets, the open Duo)', () => {
  const BESIDE: Partial<ActionBarLayoutInput> = { miniPlayerMirrors: true };
  type Moment = [string, Partial<ActionBarLayoutInput>];
  const moments: Moment[] = [
    ['nothing asked', {}],
    ['a preview', { commitButton: 'putOnWall' }],
    ['the busy-wall question', { commitButton: 'confirm' }],
    ['Fell / Sent', { workoutOutcome: true }],
    ['the busy-wall question in a block', { commitButton: 'confirm', workoutOutcome: true }],
  ];
  // [mode, moment] → [first row, second row]
  const expected: Record<string, Record<string, [string, unknown]>> = {
    wallButton: {
      'nothing asked': ['wallControlFull', []],
      'a preview': ['wallControlFull', []],
      // #7017: the pair takes the full-width wall button's place in the first row.
      'the busy-wall question': ['confirm', []],
      'Fell / Sent': ['wallControlFull', 'workoutOutcome'],
      'the busy-wall question in a block': ['confirm', []],
    },
    // The bar has the bulb: no first row, and a preview's Put on the wall takes the second.
    lightbulb: {
      'nothing asked': ['none', []],
      'a preview': ['none', ['wallControl']],
      'the busy-wall question': ['none', 'confirm'],
      'Fell / Sent': ['none', 'workoutOutcome'],
      'the busy-wall question in a block': ['none', 'confirm'],
    },
  };

  it.each(
    (['wallButton', 'lightbulb'] as const).flatMap((mode) =>
      moments.map(([moment, input]) => [mode, moment, input] as const),
    ),
  )('%s, %s', (mode, moment, input) => {
    const [first, second] = expected[mode][moment] ?? ['', null];
    for (const board of [MIRROR, MEMBER]) {
      const layout = resolveActionBarLayout({ ...board, ...BESIDE, ...input, boardControl: mode });
      expect(layout.primaryCenter).toBe(first);
      expect(layout.secondaryRow).toEqual(second);
      // The icon buttons live in the bar, and ⋯ still has every action.
      expect([layout.leadingSlot, layout.trailingSlot, layout.showPreviousNext]).toEqual([null, null, false]);
      expect(layout.hidden).toMatchObject({ tick: true, favorite: true, queue: true });
    }
  });

  it('keeps a preview’s Set active where there is no wall, and nothing else', () => {
    expect(resolveActionBarLayout({ ...MIRROR, ...BESIDE, hasWall: false }).primaryCenter).toBe('none');
    expect(
      resolveActionBarLayout({ ...MIRROR, ...BESIDE, hasWall: false, commitButton: 'putOnWall' }).primaryCenter,
    ).toBe('wallControlFull');
  });

  it('leaves the phone’s bar alone', () => {
    expect(resolveActionBarLayout(MIRROR).primaryCenter).toBe('tick');
  });
});

// #7000 review: with no wall to light the wall button has nothing to say.
describe('resolveActionBarLayout: no wall to light', () => {
  it('folds the second row away, so the board gets its height', () => {
    expect(resolveActionBarLayout({ ...MIRROR, hasWall: false }).secondaryRow).toEqual([]);
  });

  it('keeps the row for a preview, whose Set active is the way to commit it', () => {
    expect(resolveActionBarLayout({ ...MIRROR, hasWall: false, commitButton: 'putOnWall' }).secondaryRow).toEqual([
      'wallControl',
    ]);
  });

  it('still gives the row to Fell / Sent', () => {
    expect(resolveActionBarLayout({ ...MIRROR, hasWall: false, workoutOutcome: true }).secondaryRow).toBe(
      'workoutOutcome',
    );
  });
});

describe('resolveActionBarLayout: the signed-out reader', () => {
  // [⇄ or  ] [⏮] [✓] [⏭] [ ] / [40°] ··· [⬆]
  it('keeps Angle and Share in the row, with no heart, queue, bulb or wall button, and flags nothing', () => {
    expect(resolveActionBarLayout({ ...MEMBER, isAnonymous: true, commitButton: 'putOnWall' })).toEqual({
      primaryCenter: 'tick',
      leadingSlot: null,
      trailingSlot: null,
      showPreviousNext: true,
      secondaryRow: ['angle', 'spacer', 'share'],
      hidden: NOTHING_HIDDEN,
    });
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true }).leadingSlot).toBe('mirror');
  });

  it('ignores the busy-wall question, Fell / Sent and the stored switches', () => {
    const plain = resolveActionBarLayout({ ...MIRROR, isAnonymous: true });
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true, commitButton: 'confirm' })).toEqual(plain);
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true, workoutOutcome: true })).toEqual(plain);
    expect(
      resolveActionBarLayout({ ...MIRROR, isAnonymous: true, buttons: off('mirror'), previousNext: false }),
    ).toEqual(plain);
  });

  it('drops what a draft or a fixed-angle board cannot draw', () => {
    expect(
      resolveActionBarLayout({ ...MEMBER, isAnonymous: true, hasShare: false, angleAvailable: false }).secondaryRow,
    ).toEqual(['spacer']);
  });
});
