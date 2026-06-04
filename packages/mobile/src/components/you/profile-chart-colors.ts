import { V_GRADE_COLORS, FONT_GRADE_COLORS, getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { RawBar, RawBarSegment } from '@boardsesh/profile-stats';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { brandColors, withAlpha } from '../../theme/colors';

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

// Layout palette — same soft, muted hsla values the web stats charts use,
// keyed by `${boardType}-${layoutId}`.
const layoutColors: Record<string, string> = {
  'kilter-1': 'hsla(190, 55%, 52%, 0.7)',
  'kilter-8': 'hsla(160, 40%, 50%, 0.7)',
  'tension-9': 'hsla(350, 50%, 58%, 0.7)',
  'tension-10': 'hsla(20, 55%, 58%, 0.7)',
  'tension-11': 'hsla(42, 50%, 55%, 0.7)',
  'moonboard-1': 'hsla(270, 40%, 58%, 0.7)',
  'moonboard-2': 'hsla(250, 40%, 55%, 0.7)',
  'moonboard-3': 'hsla(290, 35%, 55%, 0.7)',
  'moonboard-4': 'hsla(230, 40%, 58%, 0.7)',
  'moonboard-5': 'hsla(210, 45%, 55%, 0.7)',
  'decoy-2': 'hsla(100, 40%, 52%, 0.7)',
  'touchstone-1': 'hsla(30, 50%, 55%, 0.7)',
  'grasshopper-1': 'hsla(75, 45%, 50%, 0.7)',
};

/** Color for a `${boardType}-${layoutId}` layout key. */
export function layoutChartColor(layoutKey: string): string {
  if (layoutColors[layoutKey]) return layoutColors[layoutKey];
  return layoutKey.startsWith('kilter') ? 'rgba(6, 182, 212, 0.5)' : 'rgba(239, 68, 68, 0.5)';
}

/**
 * Softened grade color for chart bars — preserves hue but lowers saturation
 * and raises lightness for a cohesive, muted look. Mirrors web's
 * `getGradeChartColor`. `gradeKey` is a grade label (e.g. "V6" or "6A").
 */
export function gradeChartColor(gradeKey: string): string {
  const normalized = gradeKey.replace(/\+$/, '');
  const hexColor = V_GRADE_COLORS[normalized] ?? FONT_GRADE_COLORS[gradeKey.toLowerCase()];
  if (!hexColor) return 'hsla(0, 0%, 78%, 0.7)';

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
  const sMuted = Math.min(Math.round(s * 100), 50);
  const lMuted = Math.max(Math.round(l * 100), 48);
  return `hsla(${hDeg}, ${sMuted}%, ${lMuted}%, 0.75)`;
}

/** Flash = sage success, Redpoint = brick error — matches the web stats chart. */
export function flashRedpointColor(seriesKey: 'flash' | 'redpoint'): string {
  return seriesKey === 'flash' ? withAlpha(brandColors.success, 0.85) : withAlpha(brandColors.error, 0.85);
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

/**
 * Sortable rank for a grade label so chart X-axes read easy→hard. Extracts the
 * V-number when present (combined Aurora labels always carry one), else maps a
 * font grade; unknown labels sort last.
 */
export function gradeSortValue(gradeLabel: string): number {
  const vMatch = gradeLabel.match(/V(\d+)/i);
  if (vMatch) return Number(vMatch[1]);
  const fontMatch = gradeLabel.match(/(\d)([abc])(\+?)/i);
  if (fontMatch) {
    const number = Number(fontMatch[1]);
    const letter = fontMatch[2].toLowerCase().charCodeAt(0) - 96; // a=1, b=2, c=3
    // Offset past the V range so a pure-font session still sorts ascending.
    return 100 + number * 10 + letter * 2 + (fontMatch[3] ? 1 : 0);
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Build grade-distribution bars for a session view. Each grade bar is the total
 * ascents (flash + send) for that grade, drawn in the grade's own vivid colour —
 * a colourful grade pyramid. Grades with no ascents are dropped; returns null
 * when the whole distribution is empty. Pass straight to `StackedBarChart` (the
 * segment carries an explicit colour, so `colorBy` is ignored for these bars).
 */
export function buildSessionGradeBars(distribution: SessionGradeDistributionItem[]): ColoredBar[] | null {
  const bars: ColoredBar[] = [];
  // Order the X-axis easy→hard regardless of the order the backend returns.
  const ordered = [...distribution].sort((a, b) => gradeSortValue(a.grade) - gradeSortValue(b.grade));
  for (const item of ordered) {
    const total = item.flash + item.send;
    if (total <= 0) continue;
    bars.push({
      key: item.grade,
      label: item.grade,
      segments: [{ value: total, key: item.grade, label: item.grade, color: gradeBadgeColor(item.grade) }],
    });
  }
  return bars.length > 0 ? bars : null;
}
