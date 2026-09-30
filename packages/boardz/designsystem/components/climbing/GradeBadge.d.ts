import * as React from 'react';

/**
 * Grade in mono, color-coded by difficulty band (--grade-1 … --grade-7).
 * Outline = open (tinted, colored ring), solid = sent (filled band color).
 * `display` is the big light readout on problem detail, in the band color.
 */
export interface GradeBadgeProps {
  /** Font ("7A+") or V ("V8") — the band is derived from it */
  grade: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** outline (open) · solid (sent) · soft (tint, no ring) · display (huge light numerals) */
  variant?: 'outline' | 'solid' | 'soft' | 'display';
  /** Small notch in the band color, top-right */
  benchmark?: boolean;
  /** Set false for the plain ink style */
  coded?: boolean;
  style?: React.CSSProperties;
}

export declare function GradeBadge(props: GradeBadgeProps): React.JSX.Element;
/** 1–7 difficulty band: ≤6A+/≤V3 · 6B/V4 · 6C/V5 · 7A/V6–7 · 7B/V8 · 7C/V9–10 · 8A+/V11+. 0 if unknown. */
export declare function gradeBand(grade: string): number;
