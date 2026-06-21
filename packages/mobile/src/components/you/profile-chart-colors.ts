import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { RawBar, RawBarSegment } from '@boardsesh/profile-stats';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { brandColors, brandColorsDark, withAlpha } from '../../theme/colors';
import { gradeSortValue } from './grade-sort-value';

export { gradeSortValue } from './grade-sort-value';

type FormatGrade = (difficulty: string | null | undefined) => string | null;

/**
 * A stacked-bar segment that may carry its own colour, overriding the chart's
 * `colorBy` resolution. Used for session grade bars (vivid grade colour for
 * sends + a gold flash cap). Plain `RawBar`s (no colour) remain valid.
 */
export type ColoredBarSegment = RawBarSegment & { color?: string };
export type ColoredBar = Omit<RawBar, 'segments'> & { segments: ColoredBarSegment[] };

// Mobile color resolution for the renderer-agnostic chart data emitted by
// @boardsesh/profile-stats. Mirrors the web adapter's palette so the two
// platforms read the same. Charts never import these from web.

type ColorSchemeName = 'light' | 'dark';

// Mobile charts need stronger marks than the softer web palette. Keep layout
// colours stable by key, but use opaque light/dark pairs with larger hue
// separation so stacked segments remain readable on M3 white and dark violet
// cards.
const layoutColors: Record<string, Record<ColorSchemeName, string>> = {
  // Kilter Original (sky blue) vs Kilter Homewall (grass green) — the two
  // dominant layouts get a clear blue-vs-green hue split so they stop reading as
  // adjacent cyan/green in the board-share donut (and the grade-distribution legend).
  'kilter-1': { light: '#0284C7', dark: '#38BDF8' },
  'kilter-8': { light: '#16A34A', dark: '#4ADE80' },
  'tension-9': { light: '#B42318', dark: '#FB7185' },
  'tension-10': { light: '#C2410C', dark: '#FDBA74' },
  'tension-11': { light: '#A16207', dark: '#FDE047' },
  'moonboard-1': { light: '#7E22CE', dark: '#C084FC' },
  'moonboard-2': { light: '#4338CA', dark: '#818CF8' },
  'moonboard-3': { light: '#BE185D', dark: '#F472B6' },
  'moonboard-4': { light: '#0F5FB8', dark: '#60A5FA' },
  'moonboard-5': { light: '#047A7A', dark: '#2DD4BF' },
  'decoy-2': { light: '#3F7A1F', dark: '#A3E635' },
  'touchstone-1': { light: '#B45309', dark: '#FBBF24' },
  'grasshopper-1': { light: '#4D7C0F', dark: '#BEF264' },
};

const fallbackLayoutPalette: Array<Record<ColorSchemeName, string>> = [
  { light: '#007C92', dark: '#22D3EE' },
  { light: '#087F5B', dark: '#34D399' },
  { light: '#B45309', dark: '#FBBF24' },
  { light: '#B42318', dark: '#FB7185' },
  { light: '#7E22CE', dark: '#C084FC' },
  { light: '#0F5FB8', dark: '#60A5FA' },
  { light: '#BE185D', dark: '#F472B6' },
  { light: '#047A7A', dark: '#2DD4BF' },
];

function stablePaletteIndex(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % fallbackLayoutPalette.length;
}

/** Color for a `${boardType}-${layoutId}` layout key. */
export function layoutChartColor(layoutKey: string, colorScheme: ColorSchemeName = 'light'): string {
  if (layoutColors[layoutKey]) return layoutColors[layoutKey][colorScheme];
  return fallbackLayoutPalette[stablePaletteIndex(layoutKey)][colorScheme];
}

/**
 * Softened grade color for chart bars — preserves hue but lowers saturation
 * and raises lightness for a cohesive, muted look. Mirrors web's
 * `getGradeChartColor`. `gradeKey` is a grade label (e.g. "V6", "6A",
 * or "V6 / 7A").
 */
export function gradeChartColor(gradeKey: string, colorScheme: ColorSchemeName = 'light'): string {
  const hexColor = getGradeColor(gradeKey);
  if (!hexColor) return colorScheme === 'dark' ? '#B8B2C4' : '#5F5868';

  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  const hDeg = Math.round(h * 360);
  const sourceSaturation = Math.round(s * 100);
  const sourceLightness = Math.round(l * 100);
  // Dark grade hexes come in near-100% saturated, which makes the warm V-grade
  // bars shout over the violet brand on the near-black page. Clamp dark
  // saturation to a calmer band (still hue-distinct across V0–V17); light mode
  // keeps its punchier floor. Lightness is unchanged so contrast holds.
  const saturation =
    colorScheme === 'dark' ? Math.min(Math.max(sourceSaturation, 60), 75) : Math.max(sourceSaturation, 82);
  const lightness =
    colorScheme === 'dark'
      ? Math.min(Math.max(sourceLightness, 58), 72)
      : Math.min(Math.max(sourceLightness - 6, 34), 48);
  return `hsl(${hDeg}, ${saturation}%, ${lightness}%)`;
}

/**
 * Flash = emerald success, Redpoint = red error. Resolves the brand semantic tone
 * for the current colour scheme so the bars stay vivid on dark chart surfaces
 * (brighter #34D399 / #F87171 in dark). Pass the chart's `colorScheme` so a bar
 * fill and its legend swatch always match.
 */
export function flashRedpointColor(seriesKey: 'flash' | 'redpoint', colorScheme: 'light' | 'dark' = 'light'): string {
  const brand = colorScheme === 'dark' ? brandColorsDark : brandColors;
  return seriesKey === 'flash' ? withAlpha(brand.success, 0.85) : withAlpha(brand.error, 0.85);
}

/**
 * Solid (vivid) grade color for badges, bars and grade text. Routes through
 * board-constants' `getGradeColor`, which extracts the V- or font-grade token
 * from a label — so combined board names like "6B+/V4" resolve to a real colour
 * instead of the grey fallback the naive map lookup produced.
 */
export function gradeBadgeColor(gradeLabel: string | null | undefined): string {
  return getGradeColor(gradeLabel) ?? DEFAULT_GRADE_COLOR;
}

export type SessionGradeBarsOptions =
  | {
      /**
       * Split each grade bar into a muted send (redpoint) base and a vivid flash
       * cap, so a brighter top band reads as "flashed".
       */
      splitFlash: true;
      /**
       * Required when splitting: the muted redpoint base is colour-scheme aware,
       * so omitting it would silently force light-mode shades on dark-mode users.
       */
      colorScheme: ColorSchemeName;
    }
  | {
      /** Each bar is a single vivid segment of flash + send (the default). */
      splitFlash?: false;
      colorScheme?: ColorSchemeName;
    };

/**
 * Build grade-distribution bars for a session view. By default each grade bar is
 * the total ascents (flash + send) for that grade, drawn in the grade's own vivid
 * colour — a colourful grade pyramid.
 *
 * With `options.splitFlash`, each bar is split into two same-hue shades: a muted
 * `gradeChartColor` send (redpoint) base and a vivid `gradeBadgeColor` flash cap.
 * The flash segment is pushed last so it renders at the top of the stack
 * (`StackedBarChart` maps `segments[0]` to the bottom of the bar). The same-hue
 * two-shade split keeps grades distinguishable across the whole V0→V17 palette.
 *
 * Grades with no ascents are dropped; returns null when the whole distribution is
 * empty. Pass straight to `StackedBarChart` (each segment carries an explicit
 * colour, so `colorBy` is ignored for these bars).
 */
export function buildSessionGradeBars(
  distribution: SessionGradeDistributionItem[],
  formatGrade?: FormatGrade,
  options?: SessionGradeBarsOptions,
): ColoredBar[] | null {
  const splitFlash = options?.splitFlash ?? false;
  const colorScheme = options?.colorScheme ?? 'light';
  const bars: ColoredBar[] = [];
  // Order the X-axis easy→hard regardless of the order the backend returns.
  const ordered = [...distribution].sort((a, b) => gradeSortValue(a.grade) - gradeSortValue(b.grade));
  for (const item of ordered) {
    const total = item.flash + item.send;
    if (total <= 0) continue;
    const label = formatGrade?.(item.grade) ?? item.grade;
    if (splitFlash) {
      const segments: ColoredBarSegment[] = [];
      // Send (redpoint) base — muted same-hue shade — sits at the bottom.
      if (item.send > 0) {
        segments.push({ value: item.send, key: item.grade, label, color: gradeChartColor(item.grade, colorScheme) });
      }
      // Flash cap — vivid same-hue shade — pushed last so it tops the stack.
      if (item.flash > 0) {
        segments.push({ value: item.flash, key: item.grade, label, color: gradeBadgeColor(item.grade) });
      }
      bars.push({ key: item.grade, label, segments });
    } else {
      bars.push({
        key: item.grade,
        label,
        segments: [{ value: total, key: item.grade, label, color: gradeBadgeColor(item.grade) }],
      });
    }
  }
  return bars.length > 0 ? bars : null;
}
