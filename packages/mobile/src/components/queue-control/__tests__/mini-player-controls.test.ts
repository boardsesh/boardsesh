import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MIN_NAME_WIDTH,
  ACCESSORY_SLOT_WIDTH,
  PHONE_ACCESSORY_MIN_NAME_WIDTH,
  isMiniPlayerButtonAvailable,
  miniPlayerCapacityWidth,
  miniPlayerPaneCoveredButtons,
  miniPlayerPaneMode,
  miniPlayerSlotCount,
  resolveMiniPlayerControls,
  type MiniPlayerControlsInput,
  type PaneCoveredButtonsInput,
} from '../mini-player-controls';
import {
  DEFAULT_MINI_PLAYER_BUTTONS,
  type MiniPlayerButtonId,
  type MiniPlayerButtonsLayout,
} from '../../../lib/mini-player-buttons';
import { DEFAULT_PLAYER_BUTTONS, type PlayerButtonId, type PlayerButtonsLayout } from '../../../lib/player-buttons';

// 16pt leading inset + 32pt artwork + 8pt gap + 4pt label padding + 8pt trailing inset.
const WIDTH_BESIDE_NAME = 68;

const GROUP_GAP = 12;

function phone(rowWidth: number | null, placement: 'regular' | 'inline' = 'regular') {
  return miniPlayerSlotCount({ placement, rowWidth, widthBesideName: WIDTH_BESIDE_NAME, wide: false, groupGap: 0 });
}
function wide(rowWidth: number | null, placement: 'regular' | 'inline' = 'regular') {
  return miniPlayerSlotCount({
    placement,
    rowWidth,
    widthBesideName: WIDTH_BESIDE_NAME,
    wide: true,
    groupGap: GROUP_GAP,
  });
}

describe('miniPlayerCapacityWidth', () => {
  it.each([null, 222, 360])('keeps phone capacity stable when its native row measures %s', (rowWidth) => {
    const capacityWidth = miniPlayerCapacityWidth({
      windowWidth: 402,
      rowWidth,
      wide: false,
      verticalTabBar: false,
    });

    expect(capacityWidth).toBe(360);
    expect(phone(capacityWidth)).toBe(3);
  });

  it.each([
    { windowWidth: 375, capacityWidth: 333, slots: 2 },
    { windowWidth: 320, capacityWidth: 278, slots: 1 },
  ])('fits $slots controls in a $windowWidth point phone window', ({ windowWidth, capacityWidth, slots }) => {
    const measuredCapacity = miniPlayerCapacityWidth({
      windowWidth,
      rowWidth: 222,
      wide: false,
      verticalTabBar: false,
    });

    expect(measuredCapacity).toBe(capacityWidth);
    expect(phone(measuredCapacity)).toBe(slots);
  });

  it('recomputes phone capacity when the window shrinks and grows', () => {
    const capacities = [402, 375, 320, 402].map((windowWidth) =>
      miniPlayerCapacityWidth({ windowWidth, rowWidth: 222, wide: false, verticalTabBar: false }),
    );

    expect(capacities).toEqual([360, 333, 278, 360]);
    expect(capacities.map((capacityWidth) => phone(capacityWidth))).toEqual([3, 2, 1, 3]);
  });

  it.each([
    { device: 'wide tablet', wide: true, verticalTabBar: false },
    { device: 'vertical tab rail', wide: false, verticalTabBar: true },
  ])(
    'follows the actual row width on a $device, including decreases and no measurement',
    ({ wide, verticalTabBar }) => {
      const measuredWidths = [995, 290, 180, null];
      const capacities = measuredWidths.map((rowWidth) =>
        miniPlayerCapacityWidth({ windowWidth: 1200, rowWidth, wide, verticalTabBar }),
      );

      expect(capacities).toEqual(measuredWidths);
    },
  );

  it('keeps a phone capacity nonnegative when the window is narrower than its insets', () => {
    expect(miniPlayerCapacityWidth({ windowWidth: 32, rowWidth: null, wide: false, verticalTabBar: false })).toBe(0);
  });
});

describe('miniPlayerSlotCount', () => {
  it('guesses what most bars measure before the first layout, so they never redraw on it', () => {
    expect(phone(null)).toBe(3);
    expect(phone(null)).toBe(phone(370));
    expect(wide(null)).toBeGreaterThanOrEqual(wide(995));
  });

  it('holds one inline, on every device', () => {
    expect(phone(370, 'inline')).toBe(1);
    expect(phone(null, 'inline')).toBe(1);
    expect(wide(995, 'inline')).toBe(1);
  });

  it('holds three in measured phone content widths of 370pt and 343pt', () => {
    expect(phone(370)).toBe(3);
    expect(phone(343)).toBe(3);
  });

  it('never holds more than three on an iPhone, however wide it reports', () => {
    expect(phone(600)).toBe(3);
  });

  it('keeps one in narrow phone content widths of 290pt and 288pt', () => {
    expect(phone(290)).toBe(1);
    expect(phone(288)).toBe(1);
  });

  it('keeps the iPhone name at 140pt or more', () => {
    const exactlyTwo = WIDTH_BESIDE_NAME + PHONE_ACCESSORY_MIN_NAME_WIDTH + 2 * ACCESSORY_SLOT_WIDTH;
    expect(phone(exactlyTwo)).toBe(2);
    expect(phone(exactlyTwo + ACCESSORY_SLOT_WIDTH - 1)).toBe(2);
    expect(phone(exactlyTwo - 1)).toBe(1);
  });

  it('gives the name the artwork room when the row has no artwork', () => {
    // No board config: 40pt less beside the name, so the Duo's 290pt platter fits two.
    const withoutArtwork = (rowWidth: number) =>
      miniPlayerSlotCount({
        placement: 'regular',
        rowWidth,
        widthBesideName: WIDTH_BESIDE_NAME - 40,
        wide: false,
        groupGap: 0,
      });
    expect(withoutArtwork(290)).toBe(2);
    expect(withoutArtwork(370)).toBe(3);
  });

  it('fits every button on an iPad (~995pt) and the open Duo (~800pt)', () => {
    expect(wide(995)).toBeGreaterThanOrEqual(9);
    expect(wide(800)).toBeGreaterThanOrEqual(9);
  });

  it('counts a wide bar against the name floor and both group gaps', () => {
    const exactlyFour = WIDTH_BESIDE_NAME + ACCESSORY_MIN_NAME_WIDTH + 2 * GROUP_GAP + 4 * ACCESSORY_SLOT_WIDTH;
    expect(wide(exactlyFour)).toBe(4);
    expect(wide(exactlyFour - 1)).toBe(3);
    expect(wide(100)).toBe(1);
  });
});

const everyButton = (buttonId: MiniPlayerButtonId) => buttonId !== undefined;

function resolve(overrides: Partial<MiniPlayerControlsInput>) {
  return resolveMiniPlayerControls({
    slotCount: 12,
    layout: DEFAULT_MINI_PLAYER_BUTTONS,
    isAvailable: everyButton,
    singleSlotShowsBulb: true,
    bulbAvailable: true,
    paneMode: 'none',
    workoutOutcome: false,
    ...overrides,
  });
}

function layoutWith(order: MiniPlayerButtonId[], on: MiniPlayerButtonId[]): MiniPlayerButtonsLayout {
  const visible = Object.fromEntries(
    DEFAULT_MINI_PLAYER_BUTTONS.order.map((buttonId) => [buttonId, on.includes(buttonId)]),
  );
  return { order, visible: visible as MiniPlayerButtonsLayout['visible'] };
}

describe('resolveMiniPlayerControls', () => {
  it('draws the defaults on a wide bar: Mirror and Favorite, then ⏮ ⏭, then the bulb and the tick', () => {
    expect(resolve({})).toEqual({
      leading: ['mirror', 'favorite', 'previous', 'next'],
      workout: [],
      trailing: ['lightbulb', 'log'],
    });
  });

  it('leaves Mirror out where the board cannot mirror', () => {
    expect(resolve({ isAvailable: (buttonId) => buttonId !== 'mirror' })).toEqual({
      leading: ['favorite', 'previous', 'next'],
      workout: [],
      trailing: ['lightbulb', 'log'],
    });
  });

  it('gives an iPhone its one extra slot to the first button in the list: Next by default', () => {
    expect(resolve({ slotCount: 3 })).toEqual({ leading: ['next'], workout: [], trailing: ['lightbulb', 'log'] });
  });

  it("follows the climber's order for who claims a short bar", () => {
    const mirrorFirst = layoutWith(
      ['mirror', 'next', 'previous', 'favorite', 'queue', 'share', 'angle'],
      ['mirror', 'next'],
    );
    expect(resolve({ slotCount: 3, layout: mirrorFirst })).toEqual({
      leading: ['mirror'],
      workout: [],
      trailing: ['lightbulb', 'log'],
    });
  });

  it("keeps ⏮ ⏭ together before the bulb, whatever the climber's order", () => {
    const shuffled = layoutWith(
      ['next', 'favorite', 'previous', 'share', 'mirror', 'queue', 'angle'],
      ['next', 'favorite', 'previous', 'share'],
    );
    expect(resolve({ layout: shuffled }).leading).toEqual(['favorite', 'share', 'previous', 'next']);
  });

  it('keeps the one slot for the bulb while the board is free, the tick otherwise', () => {
    expect(resolve({ slotCount: 1 })).toEqual({ leading: [], workout: [], trailing: ['lightbulb'] });
    expect(resolve({ slotCount: 1, singleSlotShowsBulb: false })).toEqual({
      leading: [],
      workout: [],
      trailing: ['log'],
    });
  });

  it('draws only the bulb and the tick with two slots, or when every button is off', () => {
    expect(resolve({ slotCount: 2 })).toEqual({ leading: [], workout: [], trailing: ['lightbulb', 'log'] });
    expect(resolve({ layout: layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], []) })).toEqual({
      leading: [],
      workout: [],
      trailing: ['lightbulb', 'log'],
    });
  });

  it('skips a button that cannot show here without leaving a gap', () => {
    expect(resolve({ slotCount: 3, isAvailable: (buttonId) => buttonId !== 'next' })).toEqual({
      leading: ['previous'],
      workout: [],
      trailing: ['lightbulb', 'log'],
    });
  });

  it("drops what the open Duo's player pane already shows right above the bar", () => {
    const withFavorite = layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], ['next', 'previous', 'favorite']);
    expect(
      resolve({ layout: withFavorite, paneMode: 'carry', paneCoveredButtons: ['next', 'previous', 'favorite'] }),
    ).toEqual({
      leading: ['favorite'],
      workout: [],
      trailing: [],
    });
  });
});

describe('resolveMiniPlayerControls with the pane covered (iPhone Duo open)', () => {
  it("claims from the covered row in its order, ignoring the climber's MiniPlayer list", () => {
    expect(
      resolve({
        layout: layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], []),
        paneMode: 'carry',
        paneCoveredButtons: ['favorite', 'angle', 'share'],
      }),
    ).toEqual({ leading: ['favorite', 'angle', 'share'], workout: [], trailing: [] });
  });

  it('skips the covered buttons that cannot show here', () => {
    expect(
      resolve({
        paneMode: 'carry',
        paneCoveredButtons: ['mirror', 'favorite', 'share'],
        isAvailable: (buttonId) => buttonId !== 'mirror',
      }).leading,
    ).toEqual(['favorite', 'share']);
  });

  it('never claims ⏮ ⏭ from an override while the pane shows them', () => {
    expect(resolve({ paneMode: 'carry', paneCoveredButtons: ['next', 'share'] }).leading).toEqual(['share']);
  });
});

describe('resolveMiniPlayerControls in a timed workout block', () => {
  const workout = (overrides: Partial<MiniPlayerControlsInput>) => resolve({ workoutOutcome: true, ...overrides });
  const allOn = layoutWith(
    [...DEFAULT_MINI_PLAYER_BUTTONS.order],
    ['next', 'previous', 'mirror', 'favorite', 'queue', 'share', 'angle'],
  );

  it('draws Fell, Sent, then the bulb and the tick on a wide bar (iPad, the open Duo)', () => {
    expect(workout({ slotCount: wide(995) })).toEqual({
      leading: [],
      workout: ['fell', 'sent'],
      trailing: ['lightbulb', 'log'],
    });
  });

  it("steps every one of the climber's buttons aside, ⏮ ⏭ included, so a mis-tap never skips a rep", () => {
    expect(workout({ slotCount: wide(995), layout: allOn }).leading).toEqual([]);
  });

  it("gives an iPhone's three slots to Fell, Sent and the bulb: the tick steps aside", () => {
    expect(workout({ slotCount: phone(370) })).toEqual({
      leading: [],
      workout: ['fell', 'sent'],
      trailing: ['lightbulb'],
    });
  });

  it('brings the tick back on an iPhone once the block ends', () => {
    expect(resolve({ slotCount: phone(370), workoutOutcome: false }).trailing).toEqual(['lightbulb', 'log']);
  });

  it("gives an iPhone's third slot to the tick when no board is bound: the bulb would draw nothing", () => {
    expect(workout({ slotCount: phone(370), bulbAvailable: false, singleSlotShowsBulb: false })).toEqual({
      leading: [],
      workout: ['fell', 'sent'],
      trailing: ['log'],
    });
    expect(workout({ slotCount: wide(995), bulbAvailable: false }).trailing).toEqual(['log']);
  });

  it('keeps Fell and Sent on a two-slot bar', () => {
    expect(workout({ slotCount: 2 })).toEqual({ leading: [], workout: ['fell', 'sent'], trailing: [] });
  });

  it('keeps Sent alone in one slot (the tab bar minimized), whatever the board state', () => {
    const inline = { leading: [], workout: ['sent'], trailing: [] };
    expect(workout({ slotCount: phone(370, 'inline') })).toEqual(inline);
    expect(workout({ slotCount: wide(995, 'inline'), singleSlotShowsBulb: false })).toEqual(inline);
    expect(workout({ slotCount: 1, paneMode: 'carry' })).toEqual(inline);
  });

  it("carries Fell and Sent on the Duo's pane row, without the bulb and tick the pane's big row shows", () => {
    expect(
      workout({ slotCount: wide(800), paneMode: 'carry', paneCoveredButtons: ['favorite', 'angle', 'share'] }),
    ).toEqual({ leading: [], workout: ['fell', 'sent'], trailing: [] });
  });

  it('keeps the step-aside bar (bulb and tick only) while the pane shows a preview', () => {
    expect(workout({ slotCount: wide(800), paneMode: 'stepAside' })).toEqual({
      leading: [],
      workout: [],
      trailing: ['lightbulb', 'log'],
    });
  });

  it('draws no Fell or Sent outside a block, or after the hold ends', () => {
    expect(resolve({ slotCount: wide(995) }).workout).toEqual([]);
    expect(resolve({ slotCount: 1 }).workout).toEqual([]);
  });

  it("drops ⏮ ⏭ in a timed block the climber can't log from (signed out): the other buttons stay", () => {
    const signedOutInBlock = (buttonId: MiniPlayerButtonId) =>
      isMiniPlayerButtonAvailable(buttonId, {
        inTimedBlock: true,
        mirror: true,
        signedIn: false,
        isDraft: false,
        angleAdjustable: true,
        playerRouteUp: false,
      });
    expect(resolve({ slotCount: wide(995), layout: allOn, isAvailable: signedOutInBlock })).toEqual({
      leading: ['mirror', 'share', 'angle'],
      workout: [],
      trailing: ['lightbulb', 'log'],
    });
  });
});

describe('miniPlayerPaneMode', () => {
  const pane = (overrides: Partial<Parameters<typeof miniPlayerPaneMode>[0]>) =>
    miniPlayerPaneMode({
      phoneSplit: true,
      paneTaken: false,
      paneShowsPreview: false,
      controlsPosition: 'below',
      ...overrides,
    });

  it('carries the covered row while the pane shows the current climb, controls below', () => {
    expect(pane({})).toBe('carry');
  });

  it('steps aside for a preview, or controls above the board', () => {
    expect(pane({ paneShowsPreview: true })).toBe('stepAside');
    expect(pane({ controlsPosition: 'above' })).toBe('stepAside');
  });

  it('has nothing to do with no player in the pane', () => {
    expect(pane({ phoneSplit: false })).toBe('none');
    expect(pane({ paneTaken: true, paneShowsPreview: true })).toBe('none');
  });
});

function playerLayout(order: readonly PlayerButtonId[], off: readonly PlayerButtonId[] = []): PlayerButtonsLayout {
  const visible = Object.fromEntries(order.map((buttonId) => [buttonId, !off.includes(buttonId)]));
  return { order, visible: visible as PlayerButtonsLayout['visible'] };
}

function covered(overrides: Partial<PaneCoveredButtonsInput>) {
  return miniPlayerPaneCoveredButtons({
    buttons: DEFAULT_PLAYER_BUTTONS,
    previousNext: true,
    supportsMirroring: false,
    hasShare: true,
    angleAvailable: true,
    ...overrides,
  });
}

describe('miniPlayerPaneCoveredButtons', () => {
  it("is the player's small row on a board that doesn't mirror: ♡ 40° ⬆ (☰ leads the big row)", () => {
    expect(covered({})).toEqual(['favorite', 'angle', 'share']);
  });

  it('adds the queue at the right on a mirror board, where ⇄ leads the big row', () => {
    expect(covered({ supportsMirroring: true })).toEqual(['favorite', 'angle', 'share', 'queue']);
  });

  it("follows the climber's player buttons: order and switches", () => {
    const shareFirst = playerLayout(['share', 'queue', 'favorite', 'angle', 'mirror'], ['angle']);
    expect(covered({ buttons: shareFirst })).toEqual(['share', 'favorite']);
  });

  it('leaves out Share on a draft and the angle on a fixed-angle board, as the pane does', () => {
    expect(covered({ hasShare: false, angleAvailable: false })).toEqual(['favorite']);
  });

  it('is empty when every small-row button is off', () => {
    const bigRowOnly = playerLayout(DEFAULT_PLAYER_BUTTONS.order, ['favorite', 'angle', 'share']);
    expect(covered({ buttons: bigRowOnly })).toEqual([]);
  });
});

describe('isMiniPlayerButtonAvailable', () => {
  const everything = {
    inTimedBlock: false,
    mirror: true,
    signedIn: true,
    isDraft: false,
    angleAdjustable: true,
    playerRouteUp: false,
  };
  const ids = ['next', 'previous', 'mirror', 'favorite', 'queue', 'share', 'angle'] as const;

  it('offers every button on a mirroring, adjustable board for a signed-in climber', () => {
    expect(ids.every((id) => isMiniPlayerButtonAvailable(id, everything))).toBe(true);
  });

  it('drops ⏮ ⏭ in a timed workout block', () => {
    const state = { ...everything, inTimedBlock: true };
    expect(isMiniPlayerButtonAvailable('next', state)).toBe(false);
    expect(isMiniPlayerButtonAvailable('previous', state)).toBe(false);
    expect(isMiniPlayerButtonAvailable('favorite', state)).toBe(true);
  });

  it('drops Mirror on a board that cannot mirror and Angle on a fixed-angle board', () => {
    expect(isMiniPlayerButtonAvailable('mirror', { ...everything, mirror: false })).toBe(false);
    expect(isMiniPlayerButtonAvailable('angle', { ...everything, angleAdjustable: false })).toBe(false);
  });

  it('drops Angle while the player route is up, and nothing else', () => {
    const state = { ...everything, playerRouteUp: true };
    expect(isMiniPlayerButtonAvailable('angle', state)).toBe(false);
    expect(isMiniPlayerButtonAvailable('mirror', state)).toBe(true);
    expect(isMiniPlayerButtonAvailable('favorite', state)).toBe(true);
  });

  it('drops Favorite and Queue when signed out, and Share on a draft', () => {
    const signedOut = { ...everything, signedIn: false };
    expect(isMiniPlayerButtonAvailable('favorite', signedOut)).toBe(false);
    expect(isMiniPlayerButtonAvailable('queue', signedOut)).toBe(false);
    expect(isMiniPlayerButtonAvailable('share', signedOut)).toBe(true);
    expect(isMiniPlayerButtonAvailable('share', { ...everything, isDraft: true })).toBe(false);
  });
});
