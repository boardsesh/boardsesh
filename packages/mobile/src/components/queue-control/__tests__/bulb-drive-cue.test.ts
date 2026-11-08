// Which drive cue a MiniPlayer bulb draws (owner decision 2026-11-02): the
// Live Activity's draining ring for Put on board's timed drive, the amber disc
// (or, on an unlit pick, a whole ring) for an open-ended one, nothing otherwise.
import { describe, expect, it, vi } from 'vitest';
import { blendOpaque, brandColors, brandColorsDark } from '@boardsesh/velvet-tokens';

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (colors: Record<string, string>) => colors,
}));

import { contrastRatioHex } from '../../../lib/color-contrast-oracle';
import { materialSurfaceContainers, materialTonalContainers } from '../../../theme/colors';
import { bulbHaloFor, phoneDrivesTheWall, resolveBulbDriveCue, resolvePaneBulbDriveCue } from '../bulb-drive-cue';
import type { DriveLightingMode } from '../../play-drawer/drive-mode-store';
import { EMPTY_WALL_CONTROL } from '../../play-drawer/wall-control';

describe('resolveBulbDriveCue', () => {
  it.each([
    ['window', true, 'drain'],
    ['window', false, 'drain'],
    ['driving', true, 'disc'],
    ['driving', false, 'whole'],
    ['arming', true, null],
    ['arming', false, null],
    ['off', true, null],
    ['off', false, null],
  ] as [DriveLightingMode, boolean, string | null][])('%s, lit climb %s: %s', (mode, showsLitClimb, cue) => {
    expect(resolveBulbDriveCue({ mode, drivesTheWall: true, showsLitClimb })).toBe(cue);
  });

  it.each(['window', 'driving', 'arming', 'off'] as DriveLightingMode[])(
    'draws nothing in %s when this phone is not the one driving',
    (mode) => {
      expect(resolveBulbDriveCue({ mode, drivesTheWall: false, showsLitClimb: true })).toBeNull();
      expect(resolveBulbDriveCue({ mode, drivesTheWall: false, showsLitClimb: false })).toBeNull();
    },
  );
});

describe('phoneDrivesTheWall', () => {
  it("is this phone's own link to a board with lights, and nothing else", () => {
    expect(phoneDrivesTheWall({ inAppBoardConnection: 'connectedByMe', localConnected: true, ledless: false })).toBe(
      true,
    );
    // A hold with no Bluetooth link behind it (on any board), a crewmate's board, a free board.
    expect(phoneDrivesTheWall({ inAppBoardConnection: 'connectedByMe', localConnected: false, ledless: false })).toBe(
      false,
    );
    expect(phoneDrivesTheWall({ inAppBoardConnection: 'connectedByMe', localConnected: false, ledless: true })).toBe(
      false,
    );
    expect(phoneDrivesTheWall({ inAppBoardConnection: 'heldByPeer', localConnected: true, ledless: false })).toBe(
      false,
    );
    expect(phoneDrivesTheWall({ inAppBoardConnection: 'disconnected', localConnected: true, ledless: false })).toBe(
      false,
    );
  });
});

describe('phoneDrivesTheWall on a board driven without Bluetooth', () => {
  it("draws the drive cue for this phone's live link to a wall-device board's LEDs", () => {
    // `ledless` is true on a wall-device board, but a live link writes real LEDs.
    expect(phoneDrivesTheWall({ inAppBoardConnection: 'connectedByMe', localConnected: true, ledless: true })).toBe(
      true,
    );
  });
});

describe('resolvePaneBulbDriveCue', () => {
  it("follows the pane player's model: its timed drive drains, its live drive is the disc", () => {
    expect(resolvePaneBulbDriveCue({ ...EMPTY_WALL_CONTROL, look: 'driving', lightWindow: true })).toBe('drain');
    // A timed drive drains whatever look the bulb takes.
    expect(resolvePaneBulbDriveCue({ ...EMPTY_WALL_CONTROL, look: 'lit', lightWindow: true })).toBe('drain');
    expect(resolvePaneBulbDriveCue({ ...EMPTY_WALL_CONTROL, look: 'driving', lightWindow: false })).toBe('disc');
    for (const look of ['off', 'ready', 'lit'] as const) {
      expect(resolvePaneBulbDriveCue({ ...EMPTY_WALL_CONTROL, look, lightWindow: false })).toBeNull();
    }
  });
});

describe('bulbHaloFor', () => {
  it('takes the halo out from under a draining ring only', () => {
    expect(bulbHaloFor('drain', '#B4530924')).toBeUndefined();
    for (const cue of ['disc', 'whole', null] as const) {
      expect(bulbHaloFor(cue, '#B4530924')).toBe('#B4530924');
    }
  });
});

// The ring is a graphic that carries the time left, so WCAG 1.4.11 asks 3:1
// against what it sits on: the bar itself, since the bulb draws no halo under
// it (`bulbHaloFor`) and the ring no track behind it, in light and dark. The
// worst case is 3.77:1, the held Material bar in light; a 16% amber track
// behind the arc's end left that end at 2.6:1 there. Liquid Glass has no fixed colour; it
// is measured on the iOS grounds it falls back to, under the 12% amber tint the
// bar takes while this phone holds the board. The Material bar is the
// surface-container tone, covered by the opaque violet secondary container
// while held.
describe('the drive ring’s contrast', () => {
  const NON_TEXT = 3;
  const SCHEMES = ['light', 'dark'] as const;
  type Scheme = (typeof SCHEMES)[number];
  const brandFor = (scheme: Scheme) => (scheme === 'dark' ? brandColorsDark : brandColors);
  const IOS_GROUNDS = { light: ['#FFFFFF', '#F2F2F7'], dark: ['#000000', '#1C1C1E', '#2C2C2E'] } as const;
  // `AccessoryBarSurface`: the warm tint, and the opaque violet secondary
  // container that covers the Material bar while held.
  const GLASS_WARM_TINT = 0.12;

  function bars(scheme: Scheme): string[] {
    const brand = brandFor(scheme);
    const glass = IOS_GROUNDS[scheme].flatMap((ground) => [
      ground,
      blendOpaque(brand.warning, ground, GLASS_WARM_TINT),
    ]);
    // Docked or floating, the Material bar is the `base` container.
    const material = [materialSurfaceContainers[scheme].base];
    const held = [materialTonalContainers[scheme].secondaryContainer];
    return [...glass, ...material, ...held];
  }

  it.each(SCHEMES)('clears 3:1 on every %s bar', (scheme) => {
    const ring = brandFor(scheme).warning;
    for (const bar of bars(scheme)) {
      expect(contrastRatioHex(ring, bar), `${ring} on ${bar}`).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });
});
