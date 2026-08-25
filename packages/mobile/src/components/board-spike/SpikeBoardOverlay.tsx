import React, { useMemo } from 'react';
import Svg, { Circle, ClipPath, Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import type { HoldPlacement } from '../board-renderer/types';
import { plainRingPath, polygonPath, spikyRingPath, splinePath, wavyRingPath } from './spike-shapes';
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
  boardKey: string;
  boardWidth: number;
  boardHeight: number;
  placements: HoldPlacement[];
  litHolds: SpikeLitHold[];
  halos: HaloScope;
  haloShape: HaloShape;
  selector: SelectorStyle;
  palette: SpikePaletteKey;
  /** Curve the traced outlines through their points instead of joining them straight. */
  smooth: boolean;
};

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
  boardKey,
  boardWidth,
  boardHeight,
  placements,
  litHolds,
  halos,
  haloShape,
  selector,
  palette,
  smooth,
}: SpikeBoardOverlayProps) {
  const colors = SPIKE_PALETTES[palette];
  const outlines = SPIKE_HOLD_OUTLINES[boardKey] ?? {};
  const lightness = SPIKE_HOLD_ART_LIGHTNESS[boardKey] ?? {};

  const outlinePath = useMemo(
    () =>
      (holdId: number, cx: number, cy: number): string | null => {
        const points = outlines[holdId];
        if (points === undefined || points.length < 6) return null;
        return smooth ? splinePath(points, cx, cy) : polygonPath(points, cx, cy);
      },
    [outlines, smooth],
  );

  const targets = useMemo(() => haloTargets(halos, placements, litHolds), [halos, placements, litHolds]);
  /**
   * Widest and faintest first, narrowest and brightest last. Opacity follows a
   * squared falloff so the outer bands fade quickly and the core stays solid —
   * a linear ramp still read as distinct rings.
   */
  const glowBands = useMemo(() => {
    const { glowBandCount, glowSpreadWidth, glowCoreWidth, glowPeakOpacity } = SPIKE_TUNING;
    return Array.from({ length: glowBandCount }, (_, index) => {
      const position = index / (glowBandCount - 1);
      return {
        width: glowSpreadWidth + (glowCoreWidth - glowSpreadWidth) * position,
        opacity: Number((glowPeakOpacity * (0.06 + 0.94 * position ** 2)).toFixed(3)),
      };
    });
  }, []);
  const litRoles = useMemo(() => [...new Set(litHolds.map((hold) => hold.role))], [litHolds]);
  const haloOpacity = halos === 'near' ? SPIKE_TUNING.nearHaloOpacity : SPIKE_TUNING.haloOpacity;
  const drawsGlow = selector === 'glow' || selector === 'glow-shape';
  const drawsCasing = selector === 'casing';
  const drawsShapeGlow = selector === 'shape-glow' || selector === 'shape-glow-out';
  const outwardOnly = selector === 'shape-glow-out';
  const drawsTint = selector === 'tint';
  const drawsTracedRing = selector === 'traced-ring';
  const drawsShape = selector === 'shape' || selector === 'glow-shape';
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
        {outwardOnly &&
          litHolds.map((hold) => {
            const path = outlinePath(hold.id, hold.cx, hold.cy);
            if (path === null) return null;
            return (
              // Everything on the board MINUS this hold. A stroke is centred on
              // its path, so half of every glow band would fall inside the hold
              // and wash out the surface you are about to grab; clipping to the
              // outside makes the light come off the edge the way a real LED
              // behind the hold does.
              <ClipPath key={`clip-${hold.id}`} id={`spike-outside-${hold.id}`}>
                <Path d={`M 0 0 H ${boardWidth} V ${boardHeight} H 0 Z ${path}`} clipRule="evenodd" />
              </ClipPath>
            );
          })}
      </Defs>

      <G>
        {targets.map((placement) => {
          if (haloShape === 'outline') {
            const path = outlinePath(placement.id, placement.cx, placement.cy);
            if (path === null) return null;
            // A fixed white outline is invisible on the boards that need it most:
            // Kilter Homewall, MoonBoard and TB2 draw pale holds, and white on
            // pale is nothing. Pick the outline the way `contrast-color()` would,
            // from the art measured under it.
            const onPaleArt = (lightness[placement.id] ?? 0) >= SPIKE_TUNING.casingLightnessThreshold;
            return (
              <Path
                key={`halo-${placement.id}`}
                d={path}
                fill="none"
                stroke={onPaleArt ? '#000000' : '#FFFFFF'}
                strokeOpacity={onPaleArt ? SPIKE_TUNING.outlineHaloDarkOpacity : SPIKE_TUNING.outlineHaloOpacity}
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
              stroke={(lightness[hold.id] ?? 0) >= SPIKE_TUNING.casingLightnessThreshold ? '#000000' : '#FFFFFF'}
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

        {(drawsShapeGlow || drawsTint || drawsTracedRing) &&
          litHolds.map((hold) => {
            const color = colors[hold.role] ?? '#FFFFFF';
            const path = outlinePath(hold.id, hold.cx, hold.cy);
            // No traced silhouette (a bare MoonBoard grid cell, say) — fall back
            // to a ring rather than leaving a lit hold unmarked.
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
            if (drawsTracedRing) {
              return (
                <Path
                  key={`sel-${hold.id}`}
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={SPIKE_TUNING.strokeWidth}
                  strokeLinejoin="round"
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
            // A stroke straddles its path, so the outward-only variant doubles
            // the widths: the clip throws the inner half away and the visible
            // spread of light stays the same.
            const scale = outwardOnly ? 2 : 1;
            return (
              <G key={`sel-${hold.id}`} clipPath={outwardOnly ? `url(#spike-outside-${hold.id})` : undefined}>
                {glowBands.map((band) => (
                  <Path
                    key={band.width}
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeOpacity={band.opacity}
                    strokeWidth={band.width * scale}
                    strokeLinejoin="round"
                  />
                ))}
              </G>
            );
          })}

        {!drawsShapeGlow &&
          !drawsTint &&
          !drawsTracedRing &&
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
