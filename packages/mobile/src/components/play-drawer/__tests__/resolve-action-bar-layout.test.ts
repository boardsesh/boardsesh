import { describe, expect, it } from 'vitest';
import { resolveActionBarLayout, type ActionBarLayoutInput } from '../action-bar-layout';
import { DEFAULT_PLAYER_BUTTONS, type PlayerButtonId, type PlayerButtonsLayout } from '../../../lib/player-buttons';

const MEMBER: ActionBarLayoutInput = {
  supportsMirroring: false,
  isAnonymous: false,
  connectPill: false,
  inCommitMode: false,
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
    expect(resolveActionBarLayout({ ...MEMBER, isAnonymous: true, connectPill: true, inCommitMode: true })).toEqual({
      leadingSlot: null,
      trailingSlot: null,
      showPreviousNext: true,
      secondaryRow: ['angle', 'spacer', 'share'],
      showConnectPill: false,
      hidden: NOTHING_HIDDEN,
    });
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

  it('gives the second row to the commit bar, and hands its buttons to ⋯; the first-slot queue stays', () => {
    expect(resolveActionBarLayout({ ...MEMBER, inCommitMode: true })).toEqual({
      leadingSlot: 'queue',
      trailingSlot: 'lightbulb',
      showPreviousNext: true,
      secondaryRow: 'commit',
      showConnectPill: false,
      hidden: { ...NOTHING_HIDDEN, favorite: true, share: true, angle: true },
    });
  });

  it('hands the queue to ⋯ too in commit mode on a mirror board', () => {
    expect(resolveActionBarLayout({ ...MIRROR, inCommitMode: true }).hidden).toEqual({
      favorite: true,
      share: true,
      queue: true,
      mirror: false,
      angle: true,
    });
  });

  it('lets commit mode win over the pill, which puts the bulb back in its slot', () => {
    const layout = resolveActionBarLayout({ ...MEMBER, connectPill: true, inCommitMode: true });
    expect(layout.showConnectPill).toBe(false);
    expect(layout.trailingSlot).toBe('lightbulb');
    expect(layout.secondaryRow).toBe('commit');
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
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false, inCommitMode: true }).hidden.share).toBe(false);
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

  it('brings the row back for commit mode and the connect pill', () => {
    expect(resolveActionBarLayout({ ...MEMBER, buttons: ALL_OFF, inCommitMode: true }).secondaryRow).toBe('commit');
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
