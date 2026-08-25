import React, { useMemo } from 'react';
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import type { HoldPlacement } from '../board-renderer/types';
import { plainRingPath, spikyRingPath, wavyRingPath } from './spike-shapes';
import { SPIKE_HOLD_ART_LIGHTNESS } from './spike-hold-lightness';
import { SPIKE_HOLD_OUTLINES } from './spike-hold-outlines';
import {
  SPIKE_PALETTES,
  SPIKE_TUNING,
  type HaloScope,
  type HaloShape,
  type SelectorStyle,
  type SpikeLitHold,
  type SpikePaletteKey,
} from './spike-config';

type SpikeBoardOverlayProps = {
  boardWidth: number;
  boardHeight: number;
  placements: HoldPlacement[];
  litHolds: SpikeLitHold[];
  halos: HaloScope;
  haloShape: HaloShape;
  selector: SelectorStyle;
  palette: SpikePaletteKey;
};

/**
 * A traced silhouette as an SVG path, moved to the hold's position. The table
 * stores flat [x, y, …] pairs relative to the placement centre.
 */
function outlinePath(holdId: number, cx: number, cy: number): string | null {
  const flat = SPIKE_HOLD_OUTLINES[holdId];
  if (flat === undefined || flat.length < 6) return null;
  let path = '';
  for (let index = 0; index < flat.length; index += 2) {
    path += `${index === 0 ? 'M' : 'L'} ${cx + flat[index]} ${cy + flat[index + 1]} `;
  }
  return `${path}Z`;
}

/** Placements that get a neutral outline under the current scope. */
function haloTargets(scope: HaloScope, placements: HoldPlacement[], litHolds: SpikeLitHold[]): HoldPlacement[] {
  if (scope === 'none') return [];
  if (scope === 'all') return placements;
  const reach = (placements[0]?.r ?? 0) * SPIKE_TUNING.nearRadius;
  return placements.filter((placement) =>
    litHolds.some((lit) => Math.hypot(lit.cx - placement.cx, lit.cy - placement.cy) < reach),
  );
}

/**
 * The whole spike overlay for one treatment, drawn in board-pixel space and
 * scaled to the surface by the SVG viewBox — the same coordinate contract the
 * Rust renderer's overlay PNG uses, so a treatment that reads well here can be
 * ported into `renderer.rs` unchanged.
 */
export const SpikeBoardOverlay = React.memo(function SpikeBoardOverlay({
  boardWidth,
  boardHeight,
  placements,
  litHolds,
  halos,
  haloShape,
  selector,
  palette,
}: SpikeBoardOverlayProps) {
  const colors = SPIKE_PALETTES[palette];
  const targets = useMemo(() => haloTargets(halos, placements, litHolds), [halos, placements, litHolds]);
  const litRoles = useMemo(() => [...new Set(litHolds.map((hold) => hold.role))], [litHolds]);
  const haloOpacity = halos === 'near' ? SPIKE_TUNING.nearHaloOpacity : SPIKE_TUNING.haloOpacity;
  const drawsGlow = selector === 'glow' || selector === 'glow-shape';
  const drawsCasing = selector === 'casing';
  const drawsShapeGlow = selector === 'shape-glow';
  const drawsTint = selector === 'tint';
  const drawsShape = selector === 'shape' || selector === 'glow-shape';
  // The combined treatment lets the halo carry the reach, so its outline is
  // thinner — a full-weight ring on top of the glow just reads as a blob.
  const outlineWidth = selector === 'glow-shape' ? SPIKE_TUNING.strokeWidth * 0.7 : SPIKE_TUNING.strokeWidth;

  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <Defs>
        {litRoles.map((role) => {
          const color = colors[role] ?? '#FFFFFF';
          return (
            // Transparent through the middle so the hold's own moulding still
            // shows: the halo is a light around the hold, not a disc over it.
            <RadialGradient key={role} id={`spike-glow-${role}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={color} stopOpacity={0} />
              <Stop offset="42%" stopColor={color} stopOpacity={0} />
              <Stop offset="53%" stopColor={color} stopOpacity={0.95} />
              <Stop offset="70%" stopColor={color} stopOpacity={0.34} />
              <Stop offset="100%" stopColor={color} stopOpacity={0} />
            </RadialGradient>
          );
        })}
      </Defs>

      <G>
        {targets.map((placement) => {
          if (haloShape === 'outline') {
            const path = outlinePath(placement.id, placement.cx, placement.cy);
            if (path === null) return null;
            return (
              <Path
                key={`halo-${placement.id}`}
                d={path}
                fill="none"
                stroke="#FFFFFF"
                strokeOpacity={haloOpacity}
                strokeWidth={SPIKE_TUNING.outlineHaloStrokeWidth}
                strokeLinejoin="round"
              />
            );
          }
          return (
            <Circle
              key={`halo-${placement.id}`}
              cx={placement.cx}
              cy={placement.cy}
              r={placement.r * SPIKE_TUNING.haloRadius}
              fill="none"
              stroke="#FFFFFF"
              strokeOpacity={haloOpacity}
              strokeWidth={SPIKE_TUNING.haloStrokeWidth}
            />
          );
        })}
      </G>

      <G>
        {drawsCasing &&
          litHolds.map((hold) => (
            <Circle
              key={`casing-${hold.id}`}
              cx={hold.cx}
              cy={hold.cy}
              r={hold.radius}
              fill="none"
              stroke={
                (SPIKE_HOLD_ART_LIGHTNESS[hold.id] ?? 0) >= SPIKE_TUNING.casingLightnessThreshold
                  ? '#000000'
                  : '#FFFFFF'
              }
              strokeOpacity={SPIKE_TUNING.casingOpacity}
              strokeWidth={SPIKE_TUNING.strokeWidth * SPIKE_TUNING.casingWidthMultiplier}
            />
          ))}
        {drawsGlow &&
          litHolds.map((hold) => (
            <Circle
              key={`glow-${hold.id}`}
              cx={hold.cx}
              cy={hold.cy}
              r={hold.radius * SPIKE_TUNING.glowRadius}
              fill={`url(#spike-glow-${hold.role})`}
            />
          ))}
        {(drawsShapeGlow || drawsTint) &&
          litHolds.map((hold) => {
            const color = colors[hold.role] ?? '#FFFFFF';
            const path = outlinePath(hold.id, hold.cx, hold.cy);
            // No traced silhouette for this hold — fall back to the ring rather
            // than leaving a lit hold unmarked.
            if (path === null) {
              return (
                <Circle
                  key={`sel-${hold.id}`}
                  cx={hold.cx}
                  cy={hold.cy}
                  r={hold.radius}
                  fill="none"
                  stroke={color}
                  strokeWidth={SPIKE_TUNING.strokeWidth}
                />
              );
            }
            if (drawsTint) {
              return (
                <G key={`sel-${hold.id}`}>
                  <Path d={path} fill={color} fillOpacity={SPIKE_TUNING.tintFillOpacity} />
                  <Path
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth={SPIKE_TUNING.tintEdgeWidth}
                    strokeLinejoin="round"
                  />
                </G>
              );
            }
            return (
              <G key={`sel-${hold.id}`}>
                {SPIKE_TUNING.shapeGlowBands.map((band) => (
                  <Path
                    key={band.width}
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeOpacity={band.opacity}
                    strokeWidth={band.width}
                    strokeLinejoin="round"
                  />
                ))}
              </G>
            );
          })}
        {!drawsShapeGlow &&
          !drawsTint &&
          litHolds.map((hold) => {
            const color = colors[hold.role] ?? '#FFFFFF';
            if (!drawsShape) {
              if (drawsGlow) return null;
              return (
                <Circle
                  key={`sel-${hold.id}`}
                  cx={hold.cx}
                  cy={hold.cy}
                  r={hold.radius}
                  fill="none"
                  stroke={color}
                  strokeWidth={outlineWidth}
                />
              );
            }
            const radius = selector === 'glow-shape' ? hold.radius * 1.02 : hold.radius;
            if (hold.role === 'HAND') {
              return (
                <Path
                  key={`sel-${hold.id}`}
                  d={wavyRingPath(hold.cx, hold.cy, radius)}
                  fill="none"
                  stroke={color}
                  strokeWidth={outlineWidth}
                  strokeLinejoin="round"
                />
              );
            }
            if (hold.role === 'FINISH') {
              return (
                <Path
                  key={`sel-${hold.id}`}
                  d={spikyRingPath(hold.cx, hold.cy, radius)}
                  fill="none"
                  stroke={color}
                  strokeWidth={outlineWidth}
                  strokeLinejoin="round"
                />
              );
            }
            if (hold.role === 'STARTING') {
              return (
                <Path
                  key={`sel-${hold.id}`}
                  d={wavyRingPath(hold.cx, hold.cy, radius)}
                  fill="none"
                  stroke={color}
                  strokeWidth={outlineWidth}
                  strokeDasharray="26,16"
                  strokeLinecap="round"
                />
              );
            }
            return (
              <Path
                key={`sel-${hold.id}`}
                d={plainRingPath(hold.cx, hold.cy, radius)}
                fill="none"
                stroke={color}
                strokeWidth={outlineWidth}
              />
            );
          })}
      </G>
    </Svg>
  );
});
