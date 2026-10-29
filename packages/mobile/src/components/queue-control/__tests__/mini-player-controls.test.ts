import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MIN_NAME_WIDTH,
  ACCESSORY_SLOT_WIDTH,
  PHONE_ACCESSORY_MIN_NAME_WIDTH,
  TALL_PLATTER_MIN_HEIGHT,
  accessoryPlatterGeometry,
  accessoryWidthBesideName,
  isMiniPlayerButtonAvailable,
  miniPlayerCapacityWidth,
  miniPlayerSlotCount,
  resolveMiniPlayerControls,
  trailingSlotFrame,
  miniPlayerUsesWideLayout,
  recordRowWidth,
  rowLayoutKey,
  wideRowCapacityWidth,
  type MeasuredRowWidth,
  type MiniPlayerControlsInput,
} from '../mini-player-controls';
import {
  DEFAULT_MINI_PLAYER_BUTTONS,
  type MiniPlayerButtonId,
  type MiniPlayerButtonsLayout,
} from '../../../lib/mini-player-buttons';

// 16pt leading inset + 32pt artwork + 8pt gap + 4pt label padding + 8pt trailing inset.
const WIDTH_BESIDE_NAME = 68;

function phone(rowWidth: number | null, placement: 'regular' | 'inline' = 'regular') {
  return miniPlayerSlotCount({ placement, rowWidth, widthBesideName: WIDTH_BESIDE_NAME, wide: false });
}
function wide(rowWidth: number | null, placement: 'regular' | 'inline' = 'regular') {
  return miniPlayerSlotCount({
    placement,
    rowWidth,
    widthBesideName: WIDTH_BESIDE_NAME,
    wide: true,
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

describe('wideRowCapacityWidth', () => {
  const landscape = rowLayoutKey({ windowWidth: 1210, sideInsetLeft: 0, sideInsetRight: 0 });
  const measure = (widths: readonly number[], layoutKey: string, start: MeasuredRowWidth | null = null) =>
    widths.reduce<MeasuredRowWidth | null>(
      (record, measured) => recordRowWidth(record, { layoutKey, measured }),
      start,
    );

  it('counts nothing before the first layout', () => {
    expect(wideRowCapacityWidth(null, landscape)).toBeNull();
  });

  it('ignores the squeeze UIKit gives the hidden regular row while the bar is inline', () => {
    expect(wideRowCapacityWidth(measure([889, 320], landscape), landscape)).toBe(889);
    expect(wideRowCapacityWidth(measure([889, 320, 889], landscape), landscape)).toBe(889);
  });

  it('narrows when the window does, and once the row measures under it', () => {
    const before = measure([889], landscape);
    const portrait = rowLayoutKey({ windowWidth: 834, sideInsetLeft: 0, sideInsetRight: 0 });
    // The window changed first: the latest measurement stands in.
    expect(wideRowCapacityWidth(before, portrait)).toBe(889);
    const after = measure([794], portrait, before);
    expect(wideRowCapacityWidth(after, portrait)).toBe(794);
    // The row measured before the window reported: the latest still counts.
    const early = measure([794], landscape, before);
    expect(wideRowCapacityWidth(early, portrait)).toBe(794);
  });

  it('narrows when the sidebar shows, with the window width unchanged', () => {
    const sidebar = rowLayoutKey({ windowWidth: 1210, sideInsetLeft: 320, sideInsetRight: 0 });
    expect(sidebar).not.toBe(landscape);
    const after = measure([689], sidebar, measure([889], landscape));
    expect(wideRowCapacityWidth(after, sidebar)).toBe(689);
  });

  it('returns the same record for a repeat measurement', () => {
    const record = measure([889, 320], landscape);
    expect(recordRowWidth(record, { layoutKey: landscape, measured: 320 })).toBe(record);
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
      });
    expect(withoutArtwork(290)).toBe(2);
    expect(withoutArtwork(370)).toBe(3);
  });

  it('fits every button on an iPad (~995pt) and the open Duo (~800pt)', () => {
    expect(wide(995)).toBeGreaterThanOrEqual(9);
    expect(wide(800)).toBeGreaterThanOrEqual(9);
  });

  it('counts a wide bar against the name floor, its slots at one even pitch (#7048)', () => {
    const exactlyFour = WIDTH_BESIDE_NAME + ACCESSORY_MIN_NAME_WIDTH + 4 * ACCESSORY_SLOT_WIDTH;
    expect(wide(exactlyFour)).toBe(4);
    expect(wide(exactlyFour - 1)).toBe(3);
    expect(wide(100)).toBe(1);
  });
});

describe('accessoryPlatterGeometry', () => {
  it("keeps the iPhone's 48pt platter as measured against Music", () => {
    expect(accessoryPlatterGeometry(48)).toEqual({
      leadingInset: 16,
      trailingInset: 8,
      thumbnailSize: 32,
      logGlyphSize: 24,
    });
  });

  it("centres larger artwork and a 22pt ✓ in iPad's ~62pt platter (#7048)", () => {
    expect(accessoryPlatterGeometry(62)).toEqual({
      leadingInset: 12,
      trailingInset: 10,
      thumbnailSize: 40,
      logGlyphSize: 22,
    });
  });

  it('sums the row beside the name from the geometry', () => {
    expect(accessoryWidthBesideName(accessoryPlatterGeometry(48), true)).toBe(WIDTH_BESIDE_NAME);
    expect(accessoryWidthBesideName(accessoryPlatterGeometry(62), true)).toBe(74);
    expect(accessoryWidthBesideName(accessoryPlatterGeometry(62), false)).toBe(26);
  });

  it('switches at the tall-platter threshold', () => {
    expect(accessoryPlatterGeometry(TALL_PLATTER_MIN_HEIGHT - 1).thumbnailSize).toBe(32);
    expect(accessoryPlatterGeometry(TALL_PLATTER_MIN_HEIGHT).thumbnailSize).toBe(40);
  });
});

// Every button but Wall display: an iPhone, or the open Duo, which is a phone.
const everyButton = (buttonId: MiniPlayerButtonId) => buttonId !== 'wallDisplay';

function resolve(overrides: Partial<MiniPlayerControlsInput>) {
  return resolveMiniPlayerControls({
    slotCount: 12,
    layout: DEFAULT_MINI_PLAYER_BUTTONS,
    isAvailable: everyButton,
    singleSlotShowsBulb: true,
    bulbAvailable: true,
    workoutOutcome: false,
    wideLayout: false,
    moreAvailable: true,
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
  it('draws every default in the iPhone order when the bar has room: Mirror and Favorite, then ⏮ ⏭, then 💡 ✓', () => {
    expect(resolve({})).toEqual({
      leading: ['mirror', 'favorite', 'previous', 'next'],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });

  it('leaves Mirror out where the board cannot mirror', () => {
    expect(resolve({ isAvailable: (buttonId) => buttonId !== 'mirror' })).toEqual({
      leading: ['favorite', 'previous', 'next'],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });

  it('gives an iPhone its one extra slot to the first button in the list: Next by default', () => {
    expect(resolve({ slotCount: 3 })).toEqual({
      leading: ['next'],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });

  it("follows the climber's order for who claims a short bar", () => {
    const mirrorFirst = layoutWith(
      ['mirror', 'next', 'previous', 'favorite', 'queue', 'share', 'angle'],
      ['mirror', 'next'],
    );
    expect(resolve({ slotCount: 3, layout: mirrorFirst })).toEqual({
      leading: ['mirror'],
      workout: [],
      more: false,
      wallDisplay: false,
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
    expect(resolve({ slotCount: 1 })).toEqual({
      leading: [],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb'],
    });
    expect(resolve({ slotCount: 1, singleSlotShowsBulb: false })).toEqual({
      leading: [],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['log'],
    });
  });

  it('draws only the bulb and the tick with two slots, or when every button is off', () => {
    expect(resolve({ slotCount: 2 })).toEqual({
      leading: [],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
    expect(resolve({ layout: layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], []) })).toEqual({
      leading: [],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });

  it('skips a button that cannot show here without leaving a gap', () => {
    expect(resolve({ slotCount: 3, isAvailable: (buttonId) => buttonId !== 'next' })).toEqual({
      leading: ['previous'],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });
});

describe("resolveMiniPlayerControls on a wide bar (Music's iPad layout)", () => {
  const wideBar = (overrides: Partial<MiniPlayerControlsInput>) => resolve({ wideLayout: true, ...overrides });

  it('draws ⏮ ⏭ first, then the others, and keeps ⋯ before 💡 ✓', () => {
    expect(wideBar({})).toEqual({
      leading: ['previous', 'next', 'mirror', 'favorite'],
      workout: [],
      more: true,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });

  it("keeps the climber's claim order: a short bar drops the end of the list, ⋯ claims after 💡 ✓", () => {
    expect(wideBar({ slotCount: 4 })).toMatchObject({ leading: ['next'], more: true });
    expect(wideBar({ slotCount: 5 })).toMatchObject({ leading: ['previous', 'next'], more: true });
    expect(wideBar({ slotCount: 3 })).toMatchObject({
      leading: [],
      more: true,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
    expect(wideBar({ slotCount: 2 })).toMatchObject({
      leading: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
    expect(wideBar({ slotCount: 1 })).toMatchObject({
      leading: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb'],
    });
  });

  it('puts ⏮ ⏭ first whatever order the climber chose', () => {
    const shuffled = layoutWith(
      ['next', 'favorite', 'previous', 'share', 'mirror', 'queue', 'angle'],
      ['next', 'favorite', 'previous', 'share'],
    );
    expect(wideBar({ layout: shuffled }).leading).toEqual(['previous', 'next', 'favorite', 'share']);
  });

  it('gives the ⋯ slot back to a button while the player route is up', () => {
    expect(wideBar({ slotCount: 4, moreAvailable: false })).toEqual({
      leading: ['previous', 'next'],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });

  it('never offers ⋯ on an iPhone or an inline bar', () => {
    expect(resolve({}).more).toBe(false);
    expect(resolve({ slotCount: 3 }).more).toBe(false);
    expect(miniPlayerUsesWideLayout({ wide: true, placement: 'inline' })).toBe(false);
    expect(miniPlayerUsesWideLayout({ wide: false, placement: 'regular' })).toBe(false);
    expect(miniPlayerUsesWideLayout({ wide: true, placement: 'regular' })).toBe(true);
  });

  it('in a timed block: Fell and Sent, then ⋯ 💡 ✓', () => {
    expect(wideBar({ workoutOutcome: true })).toEqual({
      leading: [],
      workout: ['fell', 'sent'],
      more: true,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
    expect(wideBar({ workoutOutcome: true, bulbAvailable: false })).toMatchObject({
      more: true,
      wallDisplay: false,
      trailing: ['log'],
    });
    // ⋯ claims last: four slots keep Fell, Sent, 💡 ✓.
    expect(wideBar({ workoutOutcome: true, slotCount: 4 })).toMatchObject({
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });

  it("draws the open Duo's 689pt capsule like an iPad: every default button, then ⋯ 💡 ✓", () => {
    expect(wideBar({ slotCount: wide(689) })).toEqual({
      leading: ['previous', 'next', 'mirror', 'favorite'],
      workout: [],
      more: true,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
    expect(wideBar({ slotCount: wide(689), workoutOutcome: true })).toEqual({
      leading: [],
      workout: ['fell', 'sent'],
      more: true,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
  });
});

describe('resolveMiniPlayerControls with Wall display (tablets)', () => {
  const tabletBar = (overrides: Partial<MiniPlayerControlsInput>) =>
    resolve({ wideLayout: true, isAvailable: () => true, ...overrides });

  it('draws ⛶ after ⋯, never in the leading cluster', () => {
    expect(tabletBar({})).toEqual({
      leading: ['previous', 'next', 'mirror', 'favorite'],
      workout: [],
      more: true,
      wallDisplay: true,
      trailing: ['lightbulb', 'log'],
    });
  });

  it("claims its slot in the climber's order, straight after Favorite by default", () => {
    // 💡 ✓ ⋯ and the four before it in the list.
    expect(tabletBar({ slotCount: 7 })).toMatchObject({ leading: ['previous', 'next', 'mirror', 'favorite'] });
    expect(tabletBar({ slotCount: 7 }).wallDisplay).toBe(false);
    expect(tabletBar({ slotCount: 8 }).wallDisplay).toBe(true);
    const wallFirst = layoutWith(
      ['wallDisplay', 'next', 'previous', 'mirror', 'favorite', 'queue', 'share', 'angle'],
      ['wallDisplay', 'next', 'previous'],
    );
    expect(tabletBar({ slotCount: 4, layout: wallFirst })).toMatchObject({ leading: [], wallDisplay: true });
  });

  it('leaves the bar when switched off, or when the bar may not offer it', () => {
    const off = layoutWith([...DEFAULT_MINI_PLAYER_BUTTONS.order], ['next', 'previous', 'mirror', 'favorite']);
    expect(tabletBar({ layout: off }).wallDisplay).toBe(false);
    expect(tabletBar({ isAvailable: (buttonId) => buttonId !== 'wallDisplay' }).wallDisplay).toBe(false);
  });

  it('never shows on an inline bar or outside the wide layout', () => {
    expect(tabletBar({ wideLayout: false }).wallDisplay).toBe(false);
    expect(tabletBar({ wideLayout: false }).leading).not.toContain('wallDisplay');
    expect(tabletBar({ slotCount: 1 }).wallDisplay).toBe(false);
  });

  it('stays in a timed block after ⋯, when the bar has room', () => {
    expect(tabletBar({ workoutOutcome: true })).toEqual({
      leading: [],
      workout: ['fell', 'sent'],
      more: true,
      wallDisplay: true,
      trailing: ['lightbulb', 'log'],
    });
    expect(tabletBar({ workoutOutcome: true, slotCount: 5 }).wallDisplay).toBe(false);
    expect(tabletBar({ workoutOutcome: true, slotCount: 6 }).wallDisplay).toBe(true);
  });
});

describe('trailingSlotFrame', () => {
  const phoneSlots = ['lightbulb', 'log'] as const;
  const wideSlots = ['more', 'lightbulb', 'log'] as const;
  const showing =
    (...shown: string[]) =>
    (slot: string) =>
      shown.includes(slot);

  it("keeps the iPhone pair's frames: a lone bulb shifts one slot to the edge", () => {
    expect(trailingSlotFrame(phoneSlots, showing('lightbulb', 'log'))).toEqual({ slotsShown: 2, trailingShift: 0 });
    expect(trailingSlotFrame(phoneSlots, showing('lightbulb'))).toEqual({ slotsShown: 1, trailingShift: 1 });
    expect(trailingSlotFrame(phoneSlots, showing('log'))).toEqual({ slotsShown: 1, trailingShift: 0 });
    expect(trailingSlotFrame(phoneSlots, showing())).toEqual({ slotsShown: 0, trailingShift: 0 });
  });

  it('spans ⋯ 💡 ✓ on a wide bar, and shifts a lone ⋯ to the edge', () => {
    expect(trailingSlotFrame(wideSlots, showing('more', 'lightbulb', 'log'))).toEqual({
      slotsShown: 3,
      trailingShift: 0,
    });
    expect(trailingSlotFrame(wideSlots, showing('lightbulb', 'log'))).toEqual({ slotsShown: 2, trailingShift: 0 });
    expect(trailingSlotFrame(wideSlots, showing('more'))).toEqual({ slotsShown: 1, trailingShift: 2 });
    // No board bound in a timed block: the bulb's slot stays empty between ⋯ and ✓.
    expect(trailingSlotFrame(wideSlots, showing('more', 'log'))).toEqual({ slotsShown: 3, trailingShift: 0 });
  });

  it('spans ⋯ ⛶ 💡 ✓ on a tablet, and keeps ⛶ beside 💡 while ⋯ is away', () => {
    const tabletSlots = ['more', 'wallDisplay', 'lightbulb', 'log'] as const;
    expect(trailingSlotFrame(tabletSlots, showing('more', 'wallDisplay', 'lightbulb', 'log'))).toEqual({
      slotsShown: 4,
      trailingShift: 0,
    });
    expect(trailingSlotFrame(tabletSlots, showing('wallDisplay', 'lightbulb', 'log'))).toEqual({
      slotsShown: 3,
      trailingShift: 0,
    });
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
      more: false,
      wallDisplay: false,
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
      more: false,
      wallDisplay: false,
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
      more: false,
      wallDisplay: false,
      trailing: ['log'],
    });
    expect(workout({ slotCount: wide(995), bulbAvailable: false }).trailing).toEqual(['log']);
  });

  it('keeps Fell and Sent on a two-slot bar', () => {
    expect(workout({ slotCount: 2 })).toEqual({
      leading: [],
      workout: ['fell', 'sent'],
      more: false,
      wallDisplay: false,
      trailing: [],
    });
  });

  it('keeps Sent alone in one slot (the tab bar minimized), whatever the board state', () => {
    const inline = { leading: [], workout: ['sent'], more: false, wallDisplay: false, trailing: [] };
    expect(workout({ slotCount: phone(370, 'inline') })).toEqual(inline);
    expect(workout({ slotCount: wide(995, 'inline'), singleSlotShowsBulb: false })).toEqual(inline);
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
        tablet: true,
      });
    expect(resolve({ slotCount: wide(995), layout: allOn, isAvailable: signedOutInBlock })).toEqual({
      leading: ['mirror', 'share', 'angle'],
      workout: [],
      more: false,
      wallDisplay: false,
      trailing: ['lightbulb', 'log'],
    });
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
    tablet: true,
  };
  const ids = ['next', 'previous', 'mirror', 'favorite', 'wallDisplay', 'queue', 'share', 'angle'] as const;

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

  it('offers Wall display on a tablet only (the open Duo is a phone)', () => {
    expect(isMiniPlayerButtonAvailable('wallDisplay', everything)).toBe(true);
    expect(isMiniPlayerButtonAvailable('wallDisplay', { ...everything, tablet: false })).toBe(false);
    expect(isMiniPlayerButtonAvailable('favorite', { ...everything, tablet: false })).toBe(true);
  });

  it('drops Angle and Wall display while the player route is up, and nothing else', () => {
    const state = { ...everything, playerRouteUp: true };
    expect(isMiniPlayerButtonAvailable('wallDisplay', state)).toBe(false);
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
