import { useColorScheme } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';

/**
 * Boardz · Graphite: ink, paper and hairlines. The only colour on screen is
 * light (the board's LEDs and a few status lights) and the grade bands.
 * Values follow `designsystem/tokens/colors.css`.
 */
export type Theme = {
  dark: boolean;
  bgApp: string;
  bgSurface: string;
  bgSurface2: string;
  /** Hover/selected step, quiet fills (tonal buttons, avatars, icon tiles). */
  bgSurface3: string;
  bgInverse: string;
  fg1: string;
  fg2: string;
  fg3: string;
  fg4: string;
  fgInverse: string;
  fgOnAccent: string;
  /** Card hairlines. */
  border1: string;
  /** Control hairlines: buttons, inputs, control strips, table rules. */
  border2: string;
  borderStrong: string;
  /** Ink in light mode, paper in dark: selected cells, switches, checkboxes. */
  accent: string;
  accentSoft: string;
  /** The main action on a screen: an LED blue, the colour of the wordmark's light. */
  primary: string;
  onPrimary: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  info: string;
  star: string;
  boardLabel: string;
  switchThumb: string;
  /** Grade bands 1–7 (≤6A+ … 8A+), used only on grades. */
  grades: readonly [string, string, string, string, string, string, string];
  /** Text on a solid grade fill. */
  gradeOn: string;
  overlay: string;
};

const INK = '#151618';
// A deeper cut of the wordmark's LED blue (#3D86FF), dark enough for white text (5:1).
const PRIMARY = '#1F5FFF';

export const lightTheme: Theme = {
  dark: false,
  bgApp: '#F4F3EF',
  bgSurface: '#FFFFFF',
  bgSurface2: '#FAFAF8',
  bgSurface3: '#EAE9E4',
  bgInverse: INK,
  fg1: INK,
  fg2: '#44464A',
  fg3: '#686A6E',
  fg4: '#A9A7A0',
  fgInverse: '#F4F3EF',
  fgOnAccent: '#F4F3EF',
  border1: '#E4E2DC',
  border2: '#D6D4CD',
  borderStrong: '#A9A7A0',
  accent: INK,
  accentSoft: '#EAE9E4',
  primary: PRIMARY,
  onPrimary: '#FFFFFF',
  success: '#2F7D52',
  successSoft: '#E3EEE6',
  danger: '#B93A2B',
  dangerSoft: '#F6E3DF',
  warning: '#8A6100',
  info: '#2D5DB8',
  star: INK,
  boardLabel: '#7C7E82',
  switchThumb: '#FFFFFF',
  grades: ['#2A7347', '#1C6E74', '#2F5FC4', '#6A45BE', '#AD2F78', '#BF3A2B', INK],
  gradeOn: '#FFFFFF',
  overlay: 'rgba(14, 15, 16, 0.36)',
};

export const darkTheme: Theme = {
  dark: true,
  bgApp: '#0E0F10',
  bgSurface: '#161719',
  bgSurface2: '#131416',
  bgSurface3: '#202124',
  bgInverse: '#EDECE8',
  fg1: '#EDECE8',
  fg2: '#A9AAAD',
  fg3: '#8A8C90',
  fg4: '#5E6064',
  fgInverse: '#0E0F10',
  fgOnAccent: '#0E0F10',
  border1: '#1F2023',
  border2: '#2A2C2F',
  borderStrong: '#45474B',
  accent: '#EDECE8',
  accentSoft: '#202124',
  primary: PRIMARY,
  onPrimary: '#FFFFFF',
  success: '#5CC48A',
  successSoft: 'rgba(92, 196, 138, 0.12)',
  danger: '#F0705E',
  dangerSoft: 'rgba(240, 112, 94, 0.12)',
  warning: '#E0B04A',
  info: '#86A8F0',
  star: '#EDECE8',
  boardLabel: '#6E7074',
  switchThumb: '#A9AAAD',
  grades: ['#4CD68A', '#3CC6C4', '#6E9BFF', '#A98BFF', '#F06BB5', '#FF6B5B', '#EDECE8'],
  gradeOn: '#0E0F10',
  overlay: 'rgba(0, 0, 0, 0.60)',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

/** Status lights: the connection pill, toasts, the dot in "Light it up". */
export const LED = {
  green: '#2BD66B',
  blue: '#3D86FF',
  amber: '#FFC53D',
  red: '#FF4A3D',
} as const;

export type BoardBackdrop = 'charcoal' | 'white' | 'yellow';

/**
 * What a board is drawn on when its art is just the holds (MoonBoard, Woods).
 * The same in both themes, so the LEDs read true. Aurora boards show their
 * own photo over it.
 */
export const BOARD_BACKDROPS: Record<BoardBackdrop, { panel: string; edge: string; hole: string }> = {
  charcoal: { panel: '#24262A', edge: '#33363B', hole: '#3C3F45' },
  white: { panel: '#F7F6F2', edge: '#DCDAD3', hole: '#CDCBC4' },
  // MoonBoard's own yellow, a shade warmer so white holds keep their edges.
  yellow: { panel: '#F2C734', edge: '#D6AC22', hole: '#D4AA27' },
};

/** Dark frames for board-like tiles, such as beta video thumbnails. */
export const BOARD_PANEL = BOARD_BACKDROPS.charcoal;

export type HoldRole = 'start' | 'hand' | 'foot' | 'finish';

/**
 * Hold colours as each board lights them on the wall. Tension's scheme (start
 * green, hand blue, finish red, foot magenta) is also how Decoy, Touchstone,
 * Grasshopper, So iLL and Woods light theirs.
 */
const HOLD_LEDS: Record<'moon' | 'kilter' | 'tension', Record<HoldRole, string>> = {
  moon: { start: '#2BD66B', hand: '#3D86FF', foot: '#FFC53D', finish: '#FF4A3D' },
  kilter: { start: '#00E676', hand: '#00CFFF', foot: '#FF9E1B', finish: '#E040FB' },
  tension: { start: '#2BD66B', hand: '#3D86FF', foot: '#B06CFF', finish: '#FF4A3D' },
};

export function holdLeds(boardName: BoardName): Record<HoldRole, string> {
  if (boardName === 'kilter') return HOLD_LEDS.kilter;
  if (boardName === 'moonboard') return HOLD_LEDS.moon;
  return HOLD_LEDS.tension;
}
