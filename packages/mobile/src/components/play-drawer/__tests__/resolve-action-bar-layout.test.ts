import { describe, expect, it } from 'vitest';
import { resolveActionBarLayout, type ActionBarLayoutInput } from '../action-bar-layout';
import { DEFAULT_PLAYER_BUTTONS, type PlayerButtonId, type PlayerButtonsLayout } from '../../../lib/player-buttons';

const MEMBER: ActionBarLayoutInput = {
  supportsMirroring: false,
  isAnonymous: false,
  connectPill: false,
  commitButton: null,
  workoutOutcome: false,
  showLightbulb: true,
  hasShare: true,
  angleAvailable: true,
  buttons: DEFAULT_PLAYER_BUTTONS,
  previousNext: true,
};
const MIRROR: ActionBarLayoutInput = { ...MEMBER, supportsMirroring: true };
const NOTHING_HIDDEN = { favorite: false, share: false, queue: false, mirror: false, angle: false };
const PLAYER_ORDER = DEFAULT_PLAYER_BUTTONS.order;

/** A layout in the given order, with the listed buttons switched off. */
function buttons(order: readonly PlayerButtonId[], off: readonly PlayerButtonId[] = []): PlayerButtonsLayout {
  const visible = { mirror: true, favorite: true, angle: true, share: true, queue: true };
  for (const buttonId of off) visible[buttonId] = false;
  return { order, visible };
}
const ALL_OFF = buttons(PLAYER_ORDER, ['mirror', 'favorite', 'angle', 'share', 'queue']);

describe('resolveActionBarLayout: the defaults draw today’s bars', () => {
  // [☰] [⏮] [✓] [⏭] [💡] / [♡] [40°] ··· [⬆]
  it('puts the queue in the first slot on a board without mirror, and hides nothing', () => {
    expect(resolveActionBarLayout(MEMBER)).toEqual({
      leadingSlot: 'queue',
      trailingSlot: 'lightbulb',
      showPreviousNext: true,
      secondaryRow: ['favorite', 'angle', 'spacer', 'share'],
      showConnectPill: false,
      hidden: NOTHING_HIDDEN,
    });
  });

  // [⇄] [⏮] [✓] [⏭] [💡] / [♡] [40°] ··· [⬆] [☰]
  it('keeps mirror first and the queue rightmost in the second row on a mirror board', () => {
    expect(resolveActionBarLayout(MIRROR)).toEqual({
      leadingSlot: 'mirror',
      trailingSlot: 'lightbulb',
      showPreviousNext: true,
      secondaryRow: ['favorite', 'angle', 'spacer', 'share', 'queue'],
      showConnectPill: false,
      hidden: NOTHING_HIDDEN,
    });
  });

  // [ ] [⏮] [✓] [⏭] [ ] / [40°] ··· [⬆]
  it('gives an anonymous reader no queue, heart or bulb, and flags nothing for a ⋯ they do not get', () => {
    expect(
      resolveActionBarLayout({ ...MEMBER, isAnonymous: true, connectPill: true, commitButton: 'putOnWall' }),
    ).toEqual({
      leadingSlot: null,
      trailingSlot: null,
      showPreviousNext: true,
      secondaryRow: ['angle', 'spacer', 'share'],
      showConnectPill: false,
      hidden: NOTHING_HIDDEN,
    });
    // No wall to take and no queue to commit into: neither latch control reaches them.
    expect(resolveActionBarLayout({ ...MEMBER, isAnonymous: true, commitButton: 'confirm' }).secondaryRow).toEqual([
      'angle',
      'spacer',
      'share',
    ]);
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true }).leadingSlot).toBe('mirror');
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true }).secondaryRow).toEqual(['angle', 'spacer', 'share']);
  });

  // Today the angle pill renders nothing on a fixed-angle board but keeps its
  // place left of the spacer, so share stays at the right end.
  it('keeps every button on its side on a fixed-angle board', () => {
    expect(resolveActionBarLayout({ ...MEMBER, angleAvailable: false }).secondaryRow).toEqual([
      'favorite',
      'spacer',
      'share',
    ]);
    expect(resolveActionBarLayout({ ...MIRROR, angleAvailable: false }).secondaryRow).toEqual([
      'favorite',
      'spacer',
      'share',
      'queue',
    ]);
    expect(resolveActionBarLayout({ ...MEMBER, isAnonymous: true, angleAvailable: false }).secondaryRow).toEqual([
      'spacer',
      'share',
    ]);
  });

  it('swaps share for the connect pill without mirror, and hands share to ⋯', () => {
    expect(resolveActionBarLayout({ ...MEMBER, connectPill: true })).toEqual({
      leadingSlot: 'queue',
      trailingSlot: null,
      showPreviousNext: true,
      secondaryRow: ['favorite', 'angle', 'spacer', 'connectPill'],
      showConnectPill: true,
      hidden: { ...NOTHING_HIDDEN, share: true },
    });
  });

  it('swaps share and the queue for the connect pill on a mirror board, and hands both to ⋯', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, connectPill: true });
    expect(layout.secondaryRow).toEqual(['favorite', 'angle', 'spacer', 'connectPill']);
    expect(layout.hidden).toEqual({ ...NOTHING_HIDDEN, share: true, queue: true });
  });

  // [☰] [⏮] [✓] [⏭] [💡] / [♡] · [Put on the wall] · [⬆]
  it('keeps one button each side of Put on the wall while browsing, and hands the angle to ⋯', () => {
    expect(resolveActionBarLayout({ ...MEMBER, commitButton: 'putOnWall' })).toEqual({
      leadingSlot: 'queue',
      trailingSlot: 'lightbulb',
      showPreviousNext: true,
      secondaryRow: ['favorite', 'spacer', 'putOnWall', 'spacer', 'share'],
      showConnectPill: false,
      hidden: { ...NOTHING_HIDDEN, angle: true },
    });
  });

  // [⇄] [⏮] [✓] [⏭] [💡] / [♡] · [Put on the wall] · [☰]
  it('keeps the heart and the rightmost queue beside Put on the wall on a mirror board, angle and share to ⋯', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, commitButton: 'putOnWall' });
    expect(layout.leadingSlot).toBe('mirror');
    expect(layout.secondaryRow).toEqual(['favorite', 'spacer', 'putOnWall', 'spacer', 'queue']);
    expect(layout.hidden).toEqual({ ...NOTHING_HIDDEN, angle: true, share: true });
  });

  it('flags only what could have drawn: an undrawable angle or share is not handed to ⋯', () => {
    const fixedAngle = resolveActionBarLayout({ ...MEMBER, commitButton: 'putOnWall', angleAvailable: false });
    expect(fixedAngle.secondaryRow).toEqual(['favorite', 'spacer', 'putOnWall', 'spacer', 'share']);
    expect(fixedAngle.hidden).toEqual(NOTHING_HIDDEN);

    // A draft has no share, so the right side is empty and the angle still steps aside.
    const draft = resolveActionBarLayout({ ...MEMBER, commitButton: 'putOnWall', hasShare: false });
    expect(draft.secondaryRow).toEqual(['favorite', 'spacer', 'putOnWall', 'spacer']);
    expect(draft.hidden).toEqual({ ...NOTHING_HIDDEN, angle: true });
  });

  // The first DRAWABLE button keeps the left place: an angle this board can't
  // change doesn't hold it empty.
  it('keeps the first drawable button on the left when an undrawable one leads', () => {
    const angleFirst = buttons(['angle', 'favorite', 'share', 'mirror', 'queue']);
    const layout = resolveActionBarLayout({
      ...MEMBER,
      buttons: angleFirst,
      commitButton: 'putOnWall',
      angleAvailable: false,
    });
    expect(layout.secondaryRow).toEqual(['favorite', 'spacer', 'putOnWall', 'spacer', 'share']);
    expect(layout.hidden).toEqual(NOTHING_HIDDEN);
    // Where it can draw, it keeps the place and the heart steps into ⋯.
    const drawable = resolveActionBarLayout({ ...MEMBER, buttons: angleFirst, commitButton: 'putOnWall' });
    expect(drawable.secondaryRow).toEqual(['angle', 'spacer', 'putOnWall', 'spacer', 'share']);
    expect(drawable.hidden).toEqual({ ...NOTHING_HIDDEN, favorite: true });
  });

  it('gives the buttons back once Put on the wall goes', () => {
    const browsing = resolveActionBarLayout({ ...MIRROR, commitButton: 'putOnWall' });
    expect(browsing.hidden.angle).toBe(true);
    const back = resolveActionBarLayout({ ...MIRROR, commitButton: null });
    expect(back.secondaryRow).toEqual(['favorite', 'angle', 'spacer', 'share', 'queue']);
    expect(back.hidden).toEqual(NOTHING_HIDDEN);
  });

  it('gives the whole second row to the busy-wall question, and hands its buttons to ⋯; the first-slot queue stays', () => {
    expect(resolveActionBarLayout({ ...MEMBER, commitButton: 'confirm' })).toEqual({
      leadingSlot: 'queue',
      trailingSlot: 'lightbulb',
      showPreviousNext: true,
      secondaryRow: 'confirm',
      showConnectPill: false,
      hidden: { ...NOTHING_HIDDEN, favorite: true, share: true, angle: true },
    });
  });

  it('hands the queue to ⋯ too under the busy-wall question on a mirror board', () => {
    expect(resolveActionBarLayout({ ...MIRROR, commitButton: 'confirm' }).hidden).toEqual({
      favorite: true,
      share: true,
      queue: true,
      mirror: false,
      angle: true,
    });
  });

  it('lets either latch control win over the pill, which puts the bulb back in its slot', () => {
    const browsing = resolveActionBarLayout({ ...MEMBER, connectPill: true, commitButton: 'putOnWall' });
    expect(browsing.showConnectPill).toBe(false);
    expect(browsing.trailingSlot).toBe('lightbulb');
    // Share keeps its place: the pill would have taken it, Put on the wall doesn't.
    expect(browsing.secondaryRow).toEqual(['favorite', 'spacer', 'putOnWall', 'spacer', 'share']);
    expect(browsing.hidden.share).toBe(false);

    const confirming = resolveActionBarLayout({ ...MEMBER, connectPill: true, commitButton: 'confirm' });
    expect(confirming.showConnectPill).toBe(false);
    expect(confirming.trailingSlot).toBe('lightbulb');
    expect(confirming.secondaryRow).toBe('confirm');
  });

  it('never shows the pill or the bulb without Bluetooth', () => {
    const layout = resolveActionBarLayout({ ...MEMBER, connectPill: true, showLightbulb: false });
    expect(layout.showConnectPill).toBe(false);
    expect(layout.trailingSlot).toBeNull();
    expect(layout.secondaryRow).toEqual(['favorite', 'angle', 'spacer', 'share']);
  });

  // A draft has no share at all (#5960), so ⋯ must not invent one either. Its
  // empty place keeps the angle pill on the left, where it sits on every climb.
  it('neither draws nor hands on share for a climb that has none', () => {
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false }).secondaryRow).toEqual([
      'favorite',
      'angle',
      'spacer',
    ]);
    expect(resolveActionBarLayout({ ...MIRROR, hasShare: false }).secondaryRow).toEqual([
      'favorite',
      'angle',
      'spacer',
      'queue',
    ]);
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false, commitButton: 'confirm' }).hidden.share).toBe(false);
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false, commitButton: 'putOnWall' }).hidden.share).toBe(false);
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false, connectPill: true }).hidden.share).toBe(false);
    const shareOff = buttons(PLAYER_ORDER, ['share']);
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false, buttons: shareOff }).hidden.share).toBe(false);
  });
});

describe('resolveActionBarLayout: the climber’s buttons', () => {
  it('collapses the second row when every small button is off, and puts each in ⋯', () => {
    expect(resolveActionBarLayout({ ...MIRROR, buttons: ALL_OFF })).toEqual({
      leadingSlot: null,
      trailingSlot: 'lightbulb',
      showPreviousNext: true,
      secondaryRow: [],
      showConnectPill: false,
      hidden: { favorite: true, share: true, queue: true, mirror: true, angle: true },
    });
    // Mirror and the angle are only flagged where this board has them.
    expect(resolveActionBarLayout({ ...MEMBER, buttons: ALL_OFF, angleAvailable: false }).hidden).toEqual({
      favorite: true,
      share: true,
      queue: true,
      mirror: false,
      angle: false,
    });
  });

  it('brings the row back for Put on the wall, the busy-wall question and the connect pill', () => {
    // Put on the wall alone, centred between the two gaps; every switched-off
    // button stays in ⋯ where it already was.
    const browsing = resolveActionBarLayout({ ...MIRROR, buttons: ALL_OFF, commitButton: 'putOnWall' });
    expect(browsing.secondaryRow).toEqual(['spacer', 'putOnWall', 'spacer']);
    expect(browsing.hidden).toEqual({ favorite: true, share: true, queue: true, mirror: true, angle: true });
    expect(resolveActionBarLayout({ ...MEMBER, buttons: ALL_OFF, commitButton: 'confirm' }).secondaryRow).toBe(
      'confirm',
    );
    expect(resolveActionBarLayout({ ...MEMBER, buttons: ALL_OFF, connectPill: true }).secondaryRow).toEqual([
      'spacer',
      'connectPill',
    ]);
  });

  it('collapses the row when all that is left on is an angle this board cannot change', () => {
    const angleOnly = buttons(PLAYER_ORDER, ['mirror', 'favorite', 'share', 'queue']);
    expect(resolveActionBarLayout({ ...MEMBER, buttons: angleOnly, angleAvailable: false }).secondaryRow).toEqual([]);
    expect(resolveActionBarLayout({ ...MEMBER, buttons: angleOnly }).secondaryRow).toEqual(['angle', 'spacer']);
  });

  // Share is the one button that comes and goes climb to climb. Collapsing for
  // a draft would move the board 52 pt on the swipe there and back.
  it('keeps an empty row for a switched-on Share on a draft, so the board does not jump', () => {
    const shareOnly = buttons(PLAYER_ORDER, ['mirror', 'favorite', 'angle', 'queue']);
    expect(resolveActionBarLayout({ ...MEMBER, buttons: shareOnly }).secondaryRow).toEqual(['share', 'spacer']);
    expect(resolveActionBarLayout({ ...MEMBER, buttons: shareOnly, hasShare: false }).secondaryRow).toEqual(['spacer']);
    expect(resolveActionBarLayout({ ...MEMBER, buttons: shareOnly, hasShare: false }).hidden.share).toBe(false);
  });

  // Tension: [☰] [⏮] [✓] [⏭] [💡] / [⇄] [♡] ··· [40°] [⬆]
  it('turns the queue big on a mirror board when it comes before Mirror', () => {
    const queueFirst = buttons(['queue', 'mirror', 'favorite', 'angle', 'share']);
    expect(resolveActionBarLayout({ ...MIRROR, buttons: queueFirst })).toMatchObject({
      leadingSlot: 'queue',
      secondaryRow: ['mirror', 'favorite', 'spacer', 'angle', 'share'],
      hidden: NOTHING_HIDDEN,
    });
  });

  it('gives the big slot to the queue when Mirror is off, and Mirror to ⋯', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, buttons: buttons(PLAYER_ORDER, ['mirror']) });
    expect(layout.leadingSlot).toBe('queue');
    expect(layout.secondaryRow).toEqual(['favorite', 'angle', 'spacer', 'share']);
    expect(layout.hidden).toEqual({ ...NOTHING_HIDDEN, mirror: true });
  });

  it('never gives the big slot to Mirror on a board that cannot mirror', () => {
    const mirrorFirst = buttons(['mirror', 'share', 'favorite', 'angle', 'queue']);
    const layout = resolveActionBarLayout({ ...MEMBER, buttons: mirrorFirst });
    expect(layout.leadingSlot).toBe('queue');
    expect(layout.secondaryRow).toEqual(['share', 'favorite', 'spacer', 'angle']);
    expect(layout.hidden.mirror).toBe(false);
  });

  it('leaves the big slot empty with both Mirror and Queue off', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, buttons: buttons(PLAYER_ORDER, ['mirror', 'queue']) });
    expect(layout.leadingSlot).toBeNull();
    expect(layout.hidden).toMatchObject({ mirror: true, queue: true });
  });

  it('splits the small row in the climber’s order, the odd one out on the left', () => {
    const order: PlayerButtonId[] = ['share', 'angle', 'favorite', 'mirror', 'queue'];
    expect(resolveActionBarLayout({ ...MEMBER, buttons: buttons(order) }).secondaryRow).toEqual([
      'share',
      'angle',
      'spacer',
      'favorite',
    ]);
    expect(resolveActionBarLayout({ ...MIRROR, buttons: buttons(order) }).secondaryRow).toEqual([
      'share',
      'angle',
      'spacer',
      'favorite',
      'queue',
    ]);
  });

  it('hands a switched-off share to ⋯', () => {
    const layout = resolveActionBarLayout({ ...MEMBER, buttons: buttons(PLAYER_ORDER, ['share']) });
    expect(layout.secondaryRow).toEqual(['favorite', 'spacer', 'angle']);
    expect(layout.hidden).toEqual({ ...NOTHING_HIDDEN, share: true });
  });

  it('empties both ⏮ ⏭ slots with Previous and next off', () => {
    expect(resolveActionBarLayout({ ...MEMBER, previousNext: false }).showPreviousNext).toBe(false);
  });

  it('gives an anonymous reader today’s bar whatever is stored on the device', () => {
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true, buttons: ALL_OFF, previousNext: false })).toEqual(
      resolveActionBarLayout({ ...MIRROR, isAnonymous: true }),
    );
  });
});

describe('resolveActionBarLayout: a timed workout block’s Fell / Sent', () => {
  const WORKOUT: ActionBarLayoutInput = { ...MEMBER, workoutOutcome: true };

  // [☰] [⏮] [✓] [⏭] [💡] / [ Fell ] [ Sent ]
  it('gives the whole small row to Fell / Sent and hands its buttons to ⋯; the first-slot queue stays', () => {
    expect(resolveActionBarLayout(WORKOUT)).toEqual({
      leadingSlot: 'queue',
      trailingSlot: 'lightbulb',
      showPreviousNext: true,
      secondaryRow: 'workoutOutcome',
      showConnectPill: false,
      hidden: { ...NOTHING_HIDDEN, favorite: true, share: true, angle: true },
    });
  });

  it('hands the queue to ⋯ too on a mirror board, and leaves Mirror in its big slot', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, workoutOutcome: true });
    expect(layout.leadingSlot).toBe('mirror');
    expect(layout.secondaryRow).toBe('workoutOutcome');
    expect(layout.hidden).toEqual({ favorite: true, share: true, queue: true, mirror: false, angle: true });
  });

  it('gives way to the busy-wall question and to Put on the wall', () => {
    expect(resolveActionBarLayout({ ...WORKOUT, commitButton: 'confirm' }).secondaryRow).toBe('confirm');
    expect(resolveActionBarLayout({ ...WORKOUT, commitButton: 'putOnWall' }).secondaryRow).toEqual(
      resolveActionBarLayout({ ...MEMBER, commitButton: 'putOnWall' }).secondaryRow,
    );
  });

  it('wins over the connect pill, which puts the bulb back in its slot', () => {
    const layout = resolveActionBarLayout({ ...WORKOUT, connectPill: true });
    expect(layout.secondaryRow).toBe('workoutOutcome');
    expect(layout.showConnectPill).toBe(false);
    expect(layout.trailingSlot).toBe('lightbulb');
  });

  it('never reaches a signed-out reader', () => {
    expect(resolveActionBarLayout({ ...WORKOUT, isAnonymous: true })).toEqual(
      resolveActionBarLayout({ ...MEMBER, isAnonymous: true }),
    );
  });

  // The row is a session state, not a button: it shows with every button off,
  // and the buttons the climber switched off stay in ⋯.
  it('brings the small row back with every button switched off', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, buttons: ALL_OFF, workoutOutcome: true });
    expect(layout.secondaryRow).toBe('workoutOutcome');
    expect(layout.hidden).toEqual({ favorite: true, share: true, queue: true, mirror: true, angle: true });
  });

  it('flags only what could have drawn here', () => {
    const draftOnFixedAngle = resolveActionBarLayout({ ...WORKOUT, hasShare: false, angleAvailable: false });
    expect(draftOnFixedAngle.hidden).toEqual({ ...NOTHING_HIDDEN, favorite: true });
  });

  it('gives the buttons back once the block is over', () => {
    expect(resolveActionBarLayout({ ...WORKOUT, workoutOutcome: false })).toEqual(resolveActionBarLayout(MEMBER));
  });
});
