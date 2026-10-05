// Sizes and colours for the no-board preview's hero: one real board drawn
// large at the top of Climbs. Pure, so the arithmetic that decides whether a
// small phone still shows a row under the board is tested without a renderer.

import { blendOpaque, materialSurfaces, withAlpha } from '@boardsesh/velvet-tokens';
import { androidFallbackColors } from '../../theme/colors';
import type { UiVariant } from '../../theme/resolve-ui-variant';

/** Side gutter of the preview, and the gap the hero keeps to each screen edge. */
export const NO_BOARD_HERO_GUTTER = 16;

/** Height of the pinned "Find my board" button. */
export const NO_BOARD_DOCK_BUTTON_HEIGHT = 50;

const HERO_MIN_HEIGHT = 200;
const HERO_MAX_HEIGHT = 380;

// What shares the first screen with the board, in points: the chip row (44)
// and its gap (12) when there is more than one board type, the caption block
// (78), and enough of the next row to show there is a list (56).
const FIXED_WITH_CHIPS = 190;
const FIXED_WITHOUT_CHIPS = 146;

export type NoBoardHeroBox = { width: number; height: number };

/**
 * The box the hero board is drawn in. As tall as the first screen allows
 * between the status bar and the pinned button, within 200 to 380 points, and
 * never wider than the screen less its gutters. `aspect` is the board's width
 * over its height.
 */
export function computeNoBoardHeroBox(params: {
  windowWidth: number;
  windowHeight: number;
  insetTop: number;
  floatingControlBottom: number;
  hasChips: boolean;
  aspect: number;
}): NoBoardHeroBox {
  const { windowWidth, windowHeight, insetTop, floatingControlBottom, hasChips, aspect } = params;
  const fixed = hasChips ? FIXED_WITH_CHIPS : FIXED_WITHOUT_CHIPS;
  const available = windowHeight - insetTop - floatingControlBottom - NO_BOARD_DOCK_BUTTON_HEIGHT - fixed;
  const height = Math.min(Math.max(available, HERO_MIN_HEIGHT), HERO_MAX_HEIGHT);
  const maxWidth = Math.max(windowWidth - NO_BOARD_HERO_GUTTER * 2, 0);
  const width = height * aspect;
  if (width <= maxWidth) return { width: Math.round(width), height: Math.round(height) };
  // A wide board on a narrow phone: the width decides, and the height follows.
  return { width: Math.round(maxWidth), height: Math.round(maxWidth / aspect) };
}

/**
 * The screen background as a hex string. A gradient cannot take the theme's
 * own value on iOS: that is a `PlatformColor`, and `expo-linear-gradient` bakes
 * it against the OS appearance instead of the app's (see `ProgressiveBlur`).
 */
export function sceneBackgroundHex(variant: UiVariant, colorScheme: 'light' | 'dark', platform: string): string {
  if (variant === 'material') return materialSurfaces[colorScheme].background;
  // iOS systemBackground.
  if (platform === 'ios') return colorScheme === 'dark' ? '#000000' : '#FFFFFF';
  return androidFallbackColors[colorScheme].background;
}

const STAGE_TINT = { light: 0.1, dark: 0.22 } as const;
const DOCK_FADE_ALPHA = 0.92;

export type NoBoardStageColors = {
  /** Top of the stage: the brand violet over the background, opaque. */
  top: string;
  background: string;
  /** `top` at zero alpha, for a fade that does not pass through grey. */
  topClear: string;
  /** The background at zero alpha and at the dock's strength. */
  backgroundClear: string;
  backgroundDock: string;
};

/** The colours behind the hero and under the dock, all concrete. */
export function noBoardStageColors(
  background: string,
  brandPrimary: string,
  colorScheme: 'light' | 'dark',
): NoBoardStageColors {
  const top = blendOpaque(brandPrimary, background, STAGE_TINT[colorScheme]);
  return {
    top,
    background,
    topClear: withAlpha(top, 0),
    backgroundClear: withAlpha(background, 0),
    backgroundDock: withAlpha(background, DOCK_FADE_ALPHA),
  };
}
