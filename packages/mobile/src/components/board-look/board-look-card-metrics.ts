import { textStyles } from '../../theme/typography';
import { spacing } from '../../theme/tokens';

/**
 * The geometry every board-preview rail shares: the preset rail, the
 * colour-vision palette rail, and the hero rail in the onboarding board-look
 * step.
 *
 * Pure — no React, no theme, no `Dimensions` — so every rule below is unit
 * testable, and so the two card components cannot drift on a number. This module
 * replaces the `BOARD_LOOK_CARD_WIDTH = 168` / `PALETTE_CARD_WIDTH = 168`
 * constants that used to provide that guarantee by being copied.
 *
 * **A card is the shape of the board it draws.** The thumb used to be a square
 * with the board letterboxed inside it, which threw away up to 39% of the
 * picture (a 0.61-aspect wall lost 64pt of a 164pt inner width) and made the
 * frame contradict its content: a square with black margins reads as
 * "thumbnail", not "your wall". Here the aspect drives the box and the board
 * fills it.
 */

/**
 * Rail thumbs are pinned by HEIGHT, not width.
 *
 * This is what keeps the Board look settings screen's vertical rhythm exactly
 * where it was: `boardLookCardHeight(1)` still returns the 228 that
 * `BOARD_LOOK_CARD_HEIGHT` did, so the pinned native row in `MoreForm` does not
 * move. Only the width now varies with the climber's board.
 */
export const RAIL_THUMB_HEIGHT = 168;

/**
 * Width clamps for a rail thumb.
 *
 * Board aspects run from 0.43 (a very tall Kilter) to 1.81 (a landscape one), so
 * an unclamped `height * aspect` would produce a 72pt splinter and a 304pt slab
 * in the same rail. The clamp costs a little letterbox at the extremes — far
 * less than the square did at the COMMON aspects, which is where it mattered.
 */
export const RAIL_MIN_WIDTH = 132;
export const RAIL_MAX_WIDTH = 200;

/**
 * How wide the Rust renderer rasterizes a preview overlay for a RAIL thumb.
 *
 * Lives here rather than beside the preview query so a card can read it without
 * importing that hook's module graph (which reaches expo-secure-store).
 * `use-board-preview-climb` re-exports it under its long-standing name.
 */
export const RAIL_RENDER_WIDTH = 600;

/** Never wider than this, or the hero stops being a card and becomes a poster. */
export const HERO_MAX_WIDTH = 420;

/**
 * Below this the hero is not worth having, and the caller falls back to the rail
 * layout.
 *
 * Not a nicety: on an iPhone SE at the largest accessibility text size the
 * header and footer eat ~490pt of a 667pt screen, leaving less room than today's
 * 228pt rail card. A hero is arithmetically impossible there. Same path covers an
 * iPad in Slide Over (~320pt).
 */
export const HERO_MIN_WIDTH = 200;

/** How much of the window a hero card may span, before the height budget applies. */
export const HERO_WIDTH_FRACTION = 0.72;

/**
 * The gap between two cards in a snapping rail.
 *
 * Owned here rather than in `SnapCarousel` because the peek arithmetic below has
 * to agree with it exactly; `SnapCarousel` re-exports it as `SNAP_CARD_GAP`.
 */
export const RAIL_CARD_GAP = spacing[3];

/**
 * The smallest slice of the next card that still says "there is another one".
 *
 * A hero rail shows ~1.2 cards where the old rail showed ~2.2, so the peek is
 * carrying information the composition used to carry for free. A climber who
 * cannot see a second card on a step with NO EXIT picks from the options they
 * believe exist.
 */
export const MIN_PEEK = 32;

/** One line of title plus the reserved two-line description. */
const TITLE_LINES = 1;
const DESCRIPTION_LINES = 2;

/**
 * The cap `Text` puts on Dynamic Type (`maxFontSizeMultiplier={1.5}`).
 *
 * Reserving space needs the SAME cap the text itself honours: React Native
 * scales `lineHeight` by the effective multiplier on both platforms (iOS
 * `RCTAttributedTextUtils.mm`, Android `TextAttributes.kt`), so a reservation
 * computed from the unscaled lineHeight silently goes inert above fontScale 1 —
 * which is exactly the bug this replaces.
 */
const MAX_FONT_SCALE = 1.5;

export type CaptionLineHeights = {
  /** Resolved `textStyles[titleVariant].lineHeight` for the active UI variant. */
  title: number;
  /** Resolved `textStyles[descriptionVariant].lineHeight` for the active variant. */
  description: number;
};

/** The rail caption's line heights. Identical in both UI variants (20 / 16). */
export const RAIL_CAPTION_LINE_HEIGHTS: CaptionLineHeights = {
  title: textStyles.subheadline.lineHeight,
  description: textStyles.caption1.lineHeight,
};

/**
 * Height of the caption block under a thumb, at a given text size.
 *
 * Callers pass the line heights resolved from the ACTIVE variant rather than the
 * static import. The rail's two (`subheadline` 20, `caption1` 16) happen to
 * agree across HIG and Material, but the hero's title (`title3`) does not — 25
 * on HIG, 28 on Material — so reading them from the theme is the only thing that
 * keeps a hero caption from clipping on Android.
 *
 * `descriptionLines` is `0` on a card that draws no description (the onboarding
 * hero). It has to be passed rather than assumed: the step sizes its hero
 * against `railSlotHeight - captionBlockHeight(...)`, so reserving two lines
 * nobody draws costs the picture ~32pt of the height it exists to spend.
 */
export function captionBlockHeight(
  lineHeights: CaptionLineHeights,
  fontScale = 1,
  descriptionLines: number = DESCRIPTION_LINES,
): number {
  const scale = Math.min(Math.max(fontScale, 1), MAX_FONT_SCALE);
  return spacing[2] + TITLE_LINES * lineHeights.title * scale + descriptionLines * lineHeights.description * scale;
}

/** Reserved height for a card's description, so every card's bottom edge lines up. */
export function descriptionMinHeight(descriptionLineHeight: number, fontScale = 1): number {
  const scale = Math.min(Math.max(fontScale, 1), MAX_FONT_SCALE);
  return DESCRIPTION_LINES * descriptionLineHeight * scale;
}

/**
 * Total height of a rail card.
 *
 * A FUNCTION rather than the old constant because a native host pins this row in
 * points before React Native has laid anything out (`MoreForm.ios.tsx` →
 * `frame({ height })`, `MoreForm.android.tsx` → `height(...)`). The old constant
 * under-reported by 26pt at the largest text size and clipped the rail; taking
 * `fontScale` fixes that at the same time as the shape change.
 *
 * `boardLookCardHeight(1) === 228`, the value the constant had — that identity is
 * the settings screen's rhythm guarantee and is asserted in the tests.
 */
export function boardLookCardHeight(
  fontScale = 1,
  lineHeights: CaptionLineHeights = RAIL_CAPTION_LINE_HEIGHTS,
): number {
  return RAIL_THUMB_HEIGHT + captionBlockHeight(lineHeights, fontScale);
}

/** The palette rail is the same card at the same size; one formula, two names. */
export const paletteCardHeight = boardLookCardHeight;

/** Width of a rail thumb for a board of this aspect. */
export function railThumbWidth(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return RAIL_MAX_WIDTH;
  return Math.round(Math.min(Math.max(RAIL_THUMB_HEIGHT * aspect, RAIL_MIN_WIDTH), RAIL_MAX_WIDTH));
}

export type HeroThumb = { width: number; height: number };

/**
 * The hero thumb, or `null` when there is not enough room to be one.
 *
 * `min()` of a width budget and a MEASURED height budget, coupled by the board's
 * own aspect. Neither budget alone works: at 283pt wide a 0.43-aspect wall is
 * 655pt tall — taller than an entire iPhone SE — and a 1.81-aspect one is a
 * 156pt letterbox with a bigger void than the layout was trying to fill. Height
 * is a hard budget, so the board is never cut off; width is capped, so a
 * landscape board still gets a hero.
 *
 * `heightBudget` must be MEASURED (`onLayout`), never computed from the window:
 * the header above it grows with the locale and the text size — the German
 * subtitle is 97 characters against 84 in en-US.
 */
export function resolveHeroThumb({
  aspect,
  windowWidth,
  heightBudget,
}: {
  aspect: number;
  windowWidth: number;
  heightBudget: number;
}): HeroThumb | null {
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  if (!Number.isFinite(heightBudget) || heightBudget <= 0) return null;

  const widthBudget = Math.min(windowWidth * HERO_WIDTH_FRACTION, HERO_MAX_WIDTH);
  const width = Math.floor(Math.min(widthBudget, heightBudget * aspect));
  if (width < HERO_MIN_WIDTH) return null;

  // A card wide enough to leave no peek would hide that the rail continues. The
  // centred card sits behind an inset of half the leftover width, so the slice of
  // a neighbour actually on screen is that inset MINUS the gap between them —
  // which is what has to clear `MIN_PEEK`, not the leftover width itself.
  const minLeftover = 2 * (MIN_PEEK + RAIL_CARD_GAP);
  if (windowWidth - width < minLeftover) {
    const capped = Math.floor(windowWidth - minLeftover);
    if (capped < HERO_MIN_WIDTH) return null;
    return { width: capped, height: Math.floor(capped / aspect) };
  }

  return { width, height: Math.floor(width / aspect) };
}

/**
 * The leading/trailing content inset that centres a card in the window.
 *
 * This — not `snapToAlignment="center"` — is what centres a rail. With this
 * inset, card `i` is centred exactly when the scroll offset is `i * interval`,
 * which is what snapping to the start of each interval already produces. Doing
 * both applies the centring twice and pushes every card off to one side.
 */
export function centeredContentInset(windowWidth: number, cardWidth: number): number {
  return Math.max(spacing[4], (windowWidth - cardWidth) / 2);
}

/** How much of each neighbour is on screen when a card is centred. */
export function neighbourPeek(windowWidth: number, cardWidth: number): number {
  return centeredContentInset(windowWidth, cardWidth) - RAIL_CARD_GAP;
}

/**
 * The rasterization width to ask the Rust renderer for, quantized onto a ladder.
 *
 * `renderWidth` is a CACHE KEY term (`buildCacheKey`, and the board `configKey`),
 * and the key records the width that was REQUESTED while the renderer clamps its
 * output to the board's own pixel width. So a raw `displayPt * pixelRatio` would
 * mint a distinct PNG for every device width, and asking for more than the source
 * has would mint a second key for byte-identical pixels. The ladder collapses the
 * fleet onto two or three rungs; the clamp keeps a rung from exceeding the source.
 */
export function quantizeRenderWidth(displayWidthPt: number, pixelRatio: number, boardWidth: number): number {
  const wanted = Math.ceil((displayWidthPt * pixelRatio) / 256) * 256;
  return Math.max(256, Math.min(boardWidth, wanted));
}

export type BoardLookCardSize = 'rail' | 'hero';

/**
 * Everything that differs between a rail card and a hero card.
 *
 * A record rather than `size === 'hero'` branches sprinkled through the card, so
 * the two scales stay describable in one place and a third one would be a single
 * entry rather than a hunt.
 */
export type CardSizeStyle = {
  titleVariant: 'subheadline' | 'title3';
  descriptionVariant: 'caption1' | 'subheadline';
  borderWidth: number;
  /** Diameter of the "open this full size" control. */
  expandSize: number;
  expandIcon: number;
  expandHitSlop: number;
  /** The hero says which look is chosen with scale and light, not a pill on the art. */
  showActiveBadge: boolean;
  dimUnselected: boolean;
  /** Scale an un-chosen neighbour shrinks to. 1 = no shrink. */
  dimScale: number;
  halo: boolean;
  /**
   * Pressed scale. Chosen so the travel is ~5pt in BOTH sizes: 0.97 of a 168pt
   * card is 5pt, but 0.97 of a 306pt hero would be 9pt of unrequested movement.
   */
  pressScale: number;
};

const RAIL_STYLE: CardSizeStyle = {
  titleVariant: 'subheadline',
  descriptionVariant: 'caption1',
  borderWidth: 2,
  expandSize: 24,
  expandIcon: 11,
  // Lifts a 24pt control to the 44pt touch floor without growing the visible pill.
  expandHitSlop: 10,
  showActiveBadge: true,
  dimUnselected: false,
  dimScale: 1,
  halo: false,
  pressScale: 0.97,
};

const HERO_STYLE: CardSizeStyle = {
  titleVariant: 'title3',
  descriptionVariant: 'subheadline',
  borderWidth: 3,
  // `glassSizes.mini` — the label-only tier of the shared size ladder.
  expandSize: 32,
  expandIcon: 15,
  expandHitSlop: 6,
  showActiveBadge: false,
  dimUnselected: true,
  dimScale: 0.92,
  halo: true,
  pressScale: 0.985,
};

export function cardSizeStyle(size: BoardLookCardSize): CardSizeStyle {
  return size === 'hero' ? HERO_STYLE : RAIL_STYLE;
}

/** Caption line heights for a size, read from the ACTIVE variant's resolved scale. */
export function captionLineHeights(
  size: BoardLookCardSize,
  resolved: Record<string, { lineHeight?: number }>,
): CaptionLineHeights {
  const style = cardSizeStyle(size);
  return {
    title: resolved[style.titleVariant]?.lineHeight ?? RAIL_CAPTION_LINE_HEIGHTS.title,
    description: resolved[style.descriptionVariant]?.lineHeight ?? RAIL_CAPTION_LINE_HEIGHTS.description,
  };
}
