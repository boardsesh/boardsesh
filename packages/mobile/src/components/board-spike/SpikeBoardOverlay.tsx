import React, { useMemo } from 'react';
import Svg, { Circle, ClipPath, Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import type { HoldPlacement } from '../board-renderer/types';
import { plainRingPath, polygonPath, spikyRingPath, splinePath, wavyRingPath } from './spike-shapes';
import { SPIKE_HOLD_ART_LIGHTNESS } from './spike-hold-lightness';
import { SPIKE_HOLD_OUTLINES } from './spike-hold-outlines';
import { SPIKE_LED_DOTS } from './spike-led-dots';
import { RoleGlyph } from './RoleGlyph';
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

/**
 * Largest extent of a traced silhouette, in board pixels. Feeds the size floor:
 * a hold much narrower than its placement circle needs the ring kept.
 */
function outlineExtent(holdId: number, boardKey: string, axis: 'longest' | 'shortest' = 'longest'): number {
  const flat = SPIKE_HOLD_OUTLINES[boardKey]?.[holdId];
  if (flat === undefined || flat.length < 6) return Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < flat.length; index += 2) {
    minX = Math.min(minX, flat[index]);
    maxX = Math.max(maxX, flat[index]);
    minY = Math.min(minY, flat[index + 1]);
    maxY = Math.max(maxY, flat[index + 1]);
  }
  return axis === 'longest' ? Math.max(maxX - minX, maxY - minY) : Math.min(maxX - minX, maxY - minY);
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
  const drawsHybrid = selector === 'glow-tint';
  const drawsTracedRing = selector === 'traced-ring';
  const drawsShape = selector === 'shape' || selector === 'glow-shape';
  const outlineWidth = selector === 'glow-shape' ? SPIKE_TUNING.strokeWidth * 0.7 : SPIKE_TUNING.strokeWidth;

  // One line width and one LED size per board: both are keyed to the placement
  // radius, which is constant within a board and carries its hold pitch.
  const placementRadius = placements[0]?.r ?? 0;
  const glyphLineWidth = Math.max(1.5, placementRadius * SPIKE_TUNING.glyphLineWidthFraction);
  const ledDotRadius = Math.max(1.5, placementRadius * SPIKE_TUNING.ledDotRadiusFraction);
  const ledData = SPIKE_LED_DOTS[boardKey];
  // MoonBoard's LED sits half a row below its hold rather than on it, so the dot
  // has to move with the board rather than always being drawn at the centre.
  const ledOffsetY = ledData?.ledOffsetY ?? 0;
  const ledHolds = useMemo(() => new Set(ledData?.hasLed ?? []), [ledData]);
  const artBrightLeds = useMemo(() => new Set(ledData?.brightInArt ?? []), [ledData]);
  const litIds = useMemo(() => new Set(litHolds.map((hold) => hold.id)), [litHolds]);

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
        {litHolds.map((hold) => {
          const path = outlinePath(hold.id, hold.cx, hold.cy);
          if (path === null) return null;
          // The silhouette edge is stroked at double width through this clip so
          // only its inner half survives. A centred stroke sits proud of the art
          // on every edge and blunts tapers into lozenges — and taper is how you
          // recognise a hold on the wall.
          return (
            <ClipPath key={`inside-${hold.id}`} id={`spike-inside-${hold.id}`}>
              <Path d={path} />
            </ClipPath>
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
            // One unconditional two-tone casing rather than a per-hold
            // black-or-white choice. The classifier version flipped polarity on
            // visually identical neighbours wherever their measured lightness
            // straddled the threshold, which reads as salt-and-pepper; a dark
            // pass with a lighter core on top reads on both pale and dark art
            // without having to decide which it is.
            return (
              <G key={`halo-${placement.id}`}>
                <Path
                  d={path}
                  fill="none"
                  stroke={SPIKE_TUNING.casingDarkColor}
                  strokeOpacity={SPIKE_TUNING.casingDarkOpacity}
                  strokeWidth={SPIKE_TUNING.casingDarkWidth}
                  strokeLinejoin="round"
                />
                <Path
                  d={path}
                  fill="none"
                  stroke={SPIKE_TUNING.casingLightColor}
                  strokeOpacity={SPIKE_TUNING.casingLightOpacity}
                  strokeWidth={SPIKE_TUNING.casingLightWidth}
                  strokeLinejoin="round"
                />
              </G>
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

      {/* The LED, taken over from the board art. Grasshopper brightens 234 of its
          332 LED locations and leaves the rest dark, so an unlit hold can look lit
          and a lit one can look dead; Tension draws all of its darker than the
          hold. Role colour where the hold is lit, dark where it is not. Central on
          Grasshopper, Tension and Woods; the bolt hole on Kilter; and half a row
          below the hold on MoonBoard, whose LED grid is offset down. */}
      <G>
        {placements.map((placement) => {
          const isLit = litIds.has(placement.id);
          const carriesLed = ledHolds.has(placement.id);
          if (isLit && !carriesLed) return null;
          if (!isLit && !artBrightLeds.has(placement.id)) return null;
          const litHold = isLit ? litHolds.find((hold) => hold.id === placement.id) : undefined;
          const fill = litHold ? (colors[litHold.role] ?? '#FFFFFF') : SPIKE_TUNING.ledDarkColor;
          return (
            <Circle
              key={`led-${placement.id}`}
              cx={placement.cx}
              cy={placement.cy + ledOffsetY}
              r={ledDotRadius}
              fill={fill}
              fillOpacity={litHold ? 1 : SPIKE_TUNING.ledDarkOpacity}
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

        {(drawsShapeGlow || drawsTint || drawsTracedRing || drawsHybrid) &&
          litHolds.map((hold) => {
            const color = colors[hold.role] ?? '#FFFFFF';
            const path = outlinePath(hold.id, hold.cx, hold.cy);
            // No traced silhouette (a bare MoonBoard grid cell, say) — fall back
            // to a ring rather than leaving a lit hold unmarked. The role mark
            // still goes on: the vocabulary has to be complete, or the absence of
            // a glyph becomes meaningful, and on MoonBoard the fallback is common
            // enough that dropping it would leave a third of a climb unlabelled.
            if (path === null) {
              return (
                <G key={`sel-${hold.id}`}>
                  <Circle
                    cx={hold.cx}
                    cy={hold.cy}
                    r={hold.radius}
                    fill="none"
                    stroke={color}
                    strokeWidth={SPIKE_TUNING.strokeWidth}
                  />
                  <RoleGlyph
                    role={hold.role}
                    cx={hold.cx}
                    cy={hold.cy}
                    reach={hold.radius}
                    lineWidth={glyphLineWidth}
                  />
                </G>
              );
            }
            // Small holds get a bigger mark, not a second one. The first pass
            // drew the baseline circle on top of the traced silhouette whenever
            // the hold was narrow, which reads as two marks disagreeing about
            // where the hold is — a precise outline and a circle that is not it.
            // Boosting the light instead keeps one shape and still stops a
            // correct-but-tiny mark from losing findability against baseline.
            const sizeFloor = hold.radius * 2 * SPIKE_TUNING.sizeFloorFraction;
            const holdExtent = outlineExtent(hold.id, boardKey);
            const smallHoldBoost = Math.min(
              SPIKE_TUNING.smallHoldMaxBoost,
              Math.max(1, sizeFloor / Math.max(1, holdExtent)),
            );
            if (drawsHybrid) {
              // Normalise the art under the hold toward a common lightness before
              // the role colour goes on, so the same role hex composites to the
              // same colour on Grasshopper's near-black holds and Kilter
              // Homewall's cream ones. Translucent, not an opaque underlay — the
              // hold's own shading and bolt hole have to survive.
              const artLightness = lightness[hold.id] ?? SPIKE_TUNING.tintNormaliseTarget;
              const target = SPIKE_TUNING.tintNormaliseTarget;
              const normaliseColor = artLightness < target ? '#FFFFFF' : '#000000';
              const normaliseOpacity =
                artLightness < target
                  ? (target - artLightness) / Math.max(1e-3, 1 - artLightness)
                  : (artLightness - target) / Math.max(1e-3, artLightness);
              return (
                <G key={`sel-${hold.id}`}>
                  <G clipPath={`url(#spike-outside-${hold.id})`}>
                    {glowBands.map((band) => (
                      <Path
                        key={band.width}
                        d={path}
                        fill="none"
                        stroke={color}
                        strokeOpacity={band.opacity}
                        strokeWidth={band.width * 2}
                        strokeLinejoin="round"
                      />
                    ))}
                  </G>
                  <Path d={path} fill={normaliseColor} fillOpacity={Math.min(0.9, normaliseOpacity)} />
                  <Path d={path} fill={color} fillOpacity={SPIKE_TUNING.tintFillOpacity} />
                  <G clipPath={`url(#spike-inside-${hold.id})`}>
                    <Path
                      d={path}
                      fill="none"
                      stroke={color}
                      strokeWidth={SPIKE_TUNING.tintBandWidth * 2}
                      strokeLinejoin="round"
                    />
                  </G>
                  <Path
                    d={path}
                    fill="none"
                    stroke="#FFFFFF"
                    strokeOpacity={0.85}
                    strokeWidth={SPIKE_TUNING.tintOuterEdgeWidth}
                    strokeLinejoin="round"
                  />
                  <RoleGlyph
                    role={hold.role}
                    cx={hold.cx}
                    cy={hold.cy}
                    reach={hold.radius * 1.6}
                    lineWidth={glyphLineWidth}
                    clipId={path === null ? undefined : `spike-inside-${hold.id}`}
                  />
                </G>
              );
            }
            if (drawsTracedRing) {
              return (
                <G key={`sel-${hold.id}`}>
                  <Path
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth={SPIKE_TUNING.strokeWidth * smallHoldBoost}
                    strokeLinejoin="round"
                  />
                  <RoleGlyph
                    role={hold.role}
                    cx={hold.cx}
                    cy={hold.cy}
                    reach={hold.radius * 1.6}
                    lineWidth={glyphLineWidth}
                    clipId={path === null ? undefined : `spike-inside-${hold.id}`}
                  />
                </G>
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
                  <RoleGlyph
                    role={hold.role}
                    cx={hold.cx}
                    cy={hold.cy}
                    reach={hold.radius * 1.6}
                    lineWidth={glyphLineWidth}
                    clipId={path === null ? undefined : `spike-inside-${hold.id}`}
                  />
                </G>
              );
            }
            // A stroke straddles its path, so the outward-only variant doubles
            // the widths: the clip throws the inner half away and the visible
            // spread of light stays the same.
            const scale = outwardOnly ? 2 : 1;
            return (
              <G key={`sel-${hold.id}`}>
                <G clipPath={outwardOnly ? `url(#spike-outside-${hold.id})` : undefined}>
                  {glowBands.map((band) => (
                    <Path
                      key={band.width}
                      d={path}
                      fill="none"
                      stroke={color}
                      strokeOpacity={band.opacity}
                      strokeWidth={band.width * scale * smallHoldBoost}
                      strokeLinejoin="round"
                    />
                  ))}
                </G>
                <RoleGlyph
                  role={hold.role}
                  cx={hold.cx}
                  cy={hold.cy}
                  reach={hold.radius * 1.6}
                  lineWidth={glyphLineWidth}
                  clipId={path === null ? undefined : `spike-inside-${hold.id}`}
                />
              </G>
            );
          })}

        {!drawsShapeGlow &&
          !drawsTint &&
          !drawsTracedRing &&
          !drawsHybrid &&
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
