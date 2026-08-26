import React from 'react';
import { Circle, G, Line } from 'react-native-svg';
import type { HoldState } from '@boardsesh/shared-schema';
import { SPIKE_TUNING } from './spike-config';

type RoleGlyphProps = {
  role: HoldState;
  cx: number;
  cy: number;
  /** Half-extent to draw the bars out to before clipping, in board pixels. */
  reach: number;
  /** One line width for every marker on the board. */
  lineWidth: number;
  /** Clip that trims the bars to the hold's own silhouette, when one exists. */
  clipId?: string;
};

/**
 * The role of a lit hold, carried by something other than hue (issue #2202).
 *
 * Hue is exactly the channel that fails: under protanopia HAND `#4455FF` and
 * FOOT `#FF00FF` land 7.7 ΔE apart, which is one colour. That is already true of
 * what ships, so it is not a regression in any candidate — but it means a
 * climber with the commonest form of colour-vision deficiency cannot tell a hand
 * from a foot on any board today.
 *
 * Every role carries a mark, so the absence of one is never meaningful:
 *
 *   FOOT   a dot          START  a horizontal bar
 *   HAND   a vertical bar FINISH an X
 *
 * The bars run edge to edge and segment the hold rather than floating inside it,
 * and every marker uses the same line width — including the foot dot, whose
 * diameter *is* that line width. Sizing a marker by the hold it sits on makes
 * the vocabulary harder to learn, not easier: the mark has to mean the same
 * thing on a jug and on a foot chip.
 *
 * X rather than a plus for FINISH, so it cannot be read as the START and HAND
 * bars drawn together.
 */
export function RoleGlyph({ role, cx, cy, reach, lineWidth, clipId }: RoleGlyphProps) {
  // Two passes, dark under light, rather than picking one colour per hold from
  // the art beneath it. The per-hold classifier flipped polarity between two
  // visually identical hand holds on the same climb — the same salt-and-pepper
  // the unlit-hold casing had. A marker has to look the same everywhere or it
  // is not a vocabulary.
  const passes = [
    {
      color: SPIKE_TUNING.glyphCasingColor,
      width: lineWidth * SPIKE_TUNING.glyphCasingWidthFactor,
      opacity: SPIKE_TUNING.glyphCasingOpacity,
    },
    { color: SPIKE_TUNING.glyphCoreColor, width: lineWidth, opacity: SPIKE_TUNING.glyphOpacity },
  ];

  if (role === 'FOOT') {
    // Diameter == the line width the bars use, so a foot reads as the same
    // weight of mark as everything else.
    return (
      <G>
        {passes.map((pass) => (
          <Circle key={pass.color} cx={cx} cy={cy} r={pass.width / 2} fill={pass.color} fillOpacity={pass.opacity} />
        ))}
      </G>
    );
  }

  /**
   * One pass of a shape, at a given colour and width. The passes are ordered
   * casing-then-core ACROSS the whole glyph, not per line: drawing each line as
   * casing+core in turn puts the second line's dark casing over the first line's
   * light core, which cut visible dark stripes through the middle of the FINISH
   * X where the diagonals cross.
   */
  const strokePass = (pass: (typeof passes)[number], key: string, segments: Array<[number, number, number, number]>) =>
    segments.map(([x1, y1, x2, y2], index) => (
      <Line
        key={`${key}-${index}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={pass.color}
        strokeWidth={pass.width}
        strokeLinecap="butt"
        strokeOpacity={pass.opacity}
      />
    ));

  const segments = ((): Array<[number, number, number, number]> => {
    if (role === 'STARTING') return [[cx - reach, cy, cx + reach, cy]];
    if (role === 'HAND') return [[cx, cy - reach, cx, cy + reach]];
    if (role === 'FINISH') {
      const diagonal = reach * Math.SQRT1_2;
      return [
        [cx - diagonal, cy - diagonal, cx + diagonal, cy + diagonal],
        [cx - diagonal, cy + diagonal, cx + diagonal, cy - diagonal],
      ];
    }
    return [];
  })();

  const body =
    segments.length === 0 ? null : (
      <G>
        {passes.map((pass, passIndex) => (
          <G key={pass.color}>{strokePass(pass, `p${passIndex}`, segments)}</G>
        ))}
      </G>
    );

  if (body === null) return null;
  // Clipped to the silhouette so the bars stop exactly at the hold's edge. Without
  // a traced silhouette (a bare MoonBoard grid cell) they are drawn unclipped at
  // the placement's own reach.
  return clipId === undefined ? body : <G clipPath={`url(#${clipId})`}>{body}</G>;
}
