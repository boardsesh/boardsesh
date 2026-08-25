import React from 'react';
import { Circle, G, Rect } from 'react-native-svg';
import type { HoldState } from '@boardsesh/shared-schema';
import { SPIKE_TUNING } from './spike-config';

type RoleGlyphProps = {
  role: HoldState;
  cx: number;
  cy: number;
  /** Marker outer diameter the glyph is sized against — the placement diameter, in every arm. */
  diameter: number;
  color: string;
};

/**
 * A second, non-colour channel for the hold's role (issue #2202).
 *
 * Every treatment in the spike carries role in hue alone, and hue is exactly the
 * channel that fails: under protanopia HAND `#4455FF` and FOOT `#FF00FF` land
 * 7.7 ΔE apart, which is one colour, not two. That is already true of what
 * ships, so it is not a regression in any candidate — but it is cheap to fix,
 * and fixing it inside the existing footprint costs no extra area on a wall that
 * is already dense.
 *
 * The channel is silhouette: none / dot / bar / cross. HAND — the most numerous
 * role — gets nothing, so the majority of marks stay clean and the glyph reads
 * as "this one is special" rather than as texture.
 */
export function RoleGlyph({ role, cx, cy, diameter, color }: RoleGlyphProps) {
  if (role === 'FOOT') {
    return <Circle cx={cx} cy={cy} r={(diameter * SPIKE_TUNING.glyphDotFraction) / 2} fill={color} />;
  }

  const barLength = diameter * SPIKE_TUNING.glyphBarLengthFraction;
  const barThickness = diameter * SPIKE_TUNING.glyphBarThicknessFraction;
  const radius = barThickness / 2;

  if (role === 'STARTING') {
    return (
      <Rect
        x={cx - barLength / 2}
        y={cy - barThickness / 2}
        width={barLength}
        height={barThickness}
        rx={radius}
        ry={radius}
        fill={color}
      />
    );
  }

  if (role === 'FINISH') {
    return (
      <G>
        <Rect
          x={cx - barLength / 2}
          y={cy - barThickness / 2}
          width={barLength}
          height={barThickness}
          rx={radius}
          ry={radius}
          fill={color}
        />
        <Rect
          x={cx - barThickness / 2}
          y={cy - barLength / 2}
          width={barThickness}
          height={barLength}
          rx={radius}
          ry={radius}
          fill={color}
        />
      </G>
    );
  }

  // HAND, and anything without a role of its own, stays clean.
  return null;
}
