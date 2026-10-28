import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MIN_NAME_WIDTH,
  ACCESSORY_SLOT_WIDTH,
  PHONE_ACCESSORY_MIN_NAME_WIDTH,
  isMiniPlayerButtonAvailable,
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

  it('holds three on an iPhone 17 Pro (~370pt) and a 375pt iPhone (~343pt)', () => {
    expect(phone(370)).toBe(3);
    expect(phone(343)).toBe(3);
  });

  it('never holds more than three on an iPhone, however wide it reports', () => {
    expect(phone(600)).toBe(3);
  });

  it("keeps one on iPhone Duo's closed platter (290pt) and a 320pt Display Zoom iPhone (~288pt)", () => {
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
    playerPaneShowsTransport: false,
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
  it('draws the defaults on a wide bar: Mirror, then ⏮ ⏭, then the bulb and the tick', () => {
    expect(resolve({})).toEqual({ leading: ['mirror', 'previous', 'next'], trailing: ['lightbulb', 'log'] });
  });

  it('leaves Mirror out where the board cannot mirror', () => {
    expect(resolve({ isAvailable: (buttonId) => buttonId !== 'mirror' })).toEqual({
      leading: ['previous', 'next'],
      trailing: ['lightbulb', 'log'],
    });
  });

  it('gives an iPhone its one extra slot to the first button in the list: Next by default', () => {
    expect(resolve({ slotCount: 3 })).toEqual({ leading: ['next'], trailing: ['lightbulb', 'log'] });
  });

  it("follows the climber's order for who claims a short bar", () => {
    const mirrorFirst = layoutWith(
      ['mirror', 'next', 'previous', 'favorite', 'queue', 'share', 'angle'],
      ['mirror', 'next'],
    );
    expect(resolve({ slotCount: 3, layout: mirrorFirst })).toEqual({
      leading: ['mirror'],
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
    expect(resolve({ slotCount: 1 })).toEqual({ leading: [], trailing: ['lightbulb'] });
    expect(resolve({ slotCount: 1, singleSlotShowsBulb: false })).toEqual({ leading: [], trailing: ['log'] });
  });

  it('draws only the bulb and the tick with two slots, or when every button is off', () => {
    expect(resolve({ slotCount: 2 })).toEqual({ leading: [], trailing: ['lightbulb', 'log'] });
    expect(resolve({ layout: layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], []) })).toEqual({
      leading: [],
      trailing: ['lightbulb', 'log'],
    });
  });

  it('skips a button that cannot show here without leaving a gap', () => {
    expect(resolve({ slotCount: 3, isAvailable: (buttonId) => buttonId !== 'next' })).toEqual({
      leading: ['previous'],
      trailing: ['lightbulb', 'log'],
    });
  });

  it("drops what the open Duo's player pane already shows right above the bar", () => {
    const withFavorite = layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], ['next', 'previous', 'favorite']);
    expect(resolve({ layout: withFavorite, playerPaneShowsTransport: true })).toEqual({
      leading: ['favorite'],
      trailing: [],
    });
  });
});

describe('resolveMiniPlayerControls with the pane covered (iPhone Duo open)', () => {
  it("claims from the covered row in its order, ignoring the climber's MiniPlayer list", () => {
    expect(
      resolve({
        layout: layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], []),
        playerPaneShowsTransport: true,
        buttonIds: ['favorite', 'angle', 'share'],
      }),
    ).toEqual({ leading: ['favorite', 'angle', 'share'], trailing: [] });
  });

  it('skips the covered buttons that cannot show here', () => {
    expect(
      resolve({
        playerPaneShowsTransport: true,
        buttonIds: ['mirror', 'favorite', 'share'],
        isAvailable: (buttonId) => buttonId !== 'mirror',
      }).leading,
    ).toEqual(['favorite', 'share']);
  });

  it('never claims ⏮ ⏭ from an override while the pane shows them', () => {
    expect(resolve({ playerPaneShowsTransport: true, buttonIds: ['next', 'share'] }).leading).toEqual(['share']);
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
    transport: true,
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

  it('drops ⏮ ⏭ when transport is unavailable (a timed workout block)', () => {
    const state = { ...everything, transport: false };
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
