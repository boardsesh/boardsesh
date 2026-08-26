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
 * Radius of the FOOT ring as a fraction of `reach`, so it is specified in the
 * same unit as the bars' length and stays constant within a board. At 0.15 the
 * ring carries 1.4x to 2.2x a bar's ink on all seven boards — the target the
 * second design pass set — and the silhouette clip still leaves some of it on
 * every one of the 2,360 traced holds. There is not much headroom above that:
 * anchored on the silhouette rather than on the bolt, 0.17 loses the whole ring
 * on two holds and 0.20 on 54 of Tension Original's foot screws.
 */
const FOOT_RING_REACH_FRACTION = 0.15;

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
 *   FOOT   a ring          START  a horizontal bar
 *   HAND   a vertical bar  FINISH an X
 *
 * The bars run edge to edge and segment the hold rather than floating inside it,
 * and every marker is stroked at the same line width, the foot ring included.
 * Sizing a marker by the hold it sits on makes the vocabulary harder to learn,
 * not easier: the mark has to mean the same thing on a jug and on a foot chip.
 *
 * X rather than a plus for FINISH, so it cannot be read as the START and HAND
 * bars drawn together. Same reason FOOT is not a short cross.
 *
 * FOOT was a disc whose diameter was that line width until the second design
 * pass measured it: 22.9 board px² of white core on Grasshopper against about
 * 270 px² for a HAND bar on the same hold, and a 2x2 block at capture resolution
 * on Kilter Original. It was also a white dot in a dark socket, which is what the
 * art already paints on every hold that carries an LED — so the mark that said
 * "foot" was the mark the wall draws anyway. And the pair it has to separate is
 * the one hue cannot: protanopia leaves HAND and FOOT 3.2 ΔE00 apart, so in the
 * protan panel a foot was identified by the absence of a bar.
 *
 * A ring rather than the filled square the same review offered, for three
 * reasons. The other three marks are strokes of one width, and a fill is a
 * second kind of ink in a four-mark vocabulary. A small filled blob is the
 * figure the art itself draws — an LED, a bolt highlight — so a square scales
 * the offending graphic up instead of replacing it, where nothing on a board
 * paints a hollow annulus. And the ring's hole is 3.4 line widths across on all
 * seven boards, so the bolt, the LED and the hold's own texture stay readable
 * through the mark, which is what the arms that fill the silhouette keep losing.
 * The hole is also where the LED goes: drawn concentric, the casing's inner edge
 * sits at 0.136 r and the core's at 0.185 r around a disc of 0.100 r. They are
 * not always concentric — the glyph anchors on the silhouette and the LED on the
 * bolt — so the ring's casing still covers a median 2% to 4% of the lit LED on
 * Grasshopper and Tension Original and 40% to 48% on the two Kilter boards,
 * against 74% to 96% for a bar's casing, which is 0.209 r wide across a 0.200 r
 * disc.
 *
 * The ring is clipped to the silhouette like the bars. On a hold too thin to
 * contain it the clip leaves an arc above and below the axis, which is still not
 * a bar. Of the 2,360 traced outlines 1,915 keep the whole circle and none loses
 * all of it; the two worst cases keep under a fifth, and both are MoonBoard 2016
 * chips narrower than the ring — which is a measurement of the clip and not of a
 * real mark, because MoonBoard has no FOOT role in `STATE_TO_PRIMARY_CODE` and
 * never draws this glyph at all. On holds that small every mark in this
 * vocabulary is a stub.
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

  const body = ((): React.ReactNode => {
    if (role === 'FOOT') {
      const ringRadius = reach * FOOT_RING_REACH_FRACTION;
      return (
        <G>
          {passes.map((pass) => (
            <Circle
              key={pass.color}
              cx={cx}
              cy={cy}
              r={ringRadius}
              fill="none"
              stroke={pass.color}
              strokeWidth={pass.width}
              strokeOpacity={pass.opacity}
            />
          ))}
        </G>
      );
    }
    if (segments.length === 0) return null;
    return (
      <G>
        {passes.map((pass, passIndex) => (
          <G key={pass.color}>{strokePass(pass, `p${passIndex}`, segments)}</G>
        ))}
      </G>
    );
  })();

  if (body === null) return null;
  // Clipped to the silhouette so the marks stop exactly at the hold's edge. Without
  // a traced silhouette (a bare MoonBoard grid cell) they are drawn unclipped at
  // the placement's own reach.
  return clipId === undefined ? body : <G clipPath={`url(#${clipId})`}>{body}</G>;
}
