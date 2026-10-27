import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MIN_NAME_WIDTH,
  ACCESSORY_SLOT_WIDTH,
  PHONE_ACCESSORY_MIN_NAME_WIDTH,
  miniPlayerSlotCount,
  resolveMiniPlayerControls,
  type MiniPlayerControlsInput,
} from '../mini-player-controls';
import {
  DEFAULT_MINI_PLAYER_BUTTONS,
  type MiniPlayerButtonId,
  type MiniPlayerButtonsLayout,
} from '../../../lib/mini-player-buttons';

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
