// Marker signatures the installed renderer refused, and the override set it can
// still draw. Split out of use-native-climb-render.ts (which re-exports these
// for its own call sites and test seams) so a surface that has to match the
// board's markers, such as the Active holds section, can read the same answer
// without importing the native render graph and its `expo-asset` imports.
import { useMemo, useSyncExternalStore } from 'react';
import {
  DEFAULT_HOLD_BRUSH_THICKNESS,
  DEFAULT_HOLD_COLOR_SIGNATURE,
  DEFAULT_HOLD_SHAPE_SIZE,
  buildHoldColorOverrideSignature,
  useHoldColorOverrides,
  type HoldColorOverrides,
  type HoldShapeOverrides,
} from '../lib/hold-color-overrides';

// Render signatures the installed renderer told us it cannot honour (an old
// native binary that predates marker support throws
// MARKER_RENDERER_UNAVAILABLE_MESSAGE). Module-scoped: one refusal is a
// property of the binary, not of the climb, so every hook instance learns from
// it. `unsupportedSignatureRevision` is the useSyncExternalStore tick — without
// it a Set mutated inside a promise catch would never reach the components that
// have to re-resolve which overrides they can still ask for.
const unsupportedRenderSignatures = new Set<string>();
const unsupportedSignatureListeners = new Set<() => void>();
let unsupportedSignatureRevision = 0;

export function markRenderSignatureUnsupported(renderSignature: string): void {
  if (unsupportedRenderSignatures.has(renderSignature)) return;
  unsupportedRenderSignatures.add(renderSignature);
  unsupportedSignatureRevision += 1;
  for (const listener of unsupportedSignatureListeners) listener();
}

export function isRenderSignatureUnsupported(renderSignature: string): boolean {
  return unsupportedRenderSignatures.has(renderSignature);
}

export function subscribeToUnsupportedSignatures(onStoreChange: () => void): () => void {
  unsupportedSignatureListeners.add(onStoreChange);
  return () => {
    unsupportedSignatureListeners.delete(onStoreChange);
  };
}

export function getUnsupportedSignatureRevision(): number {
  return unsupportedSignatureRevision;
}

const EMPTY_HOLD_COLOR_OVERRIDES: HoldColorOverrides = {};
const EMPTY_HOLD_SHAPE_OVERRIDES: HoldShapeOverrides = {};

/** The override set the installed renderer can actually draw, plus its signature. */
export type EffectiveRenderOverrides = {
  signature: string;
  colors: HoldColorOverrides;
  shapes: HoldShapeOverrides;
  brushThickness: number;
  shapeSize: number;
};

/**
 * Pick the richest override set the renderer has not refused.
 *
 * A refusal is about marker GEOMETRY — shape, size, brush — which only the
 * marker-aware binaries draw. Colours are honoured by every binary ever
 * shipped, so the fallback keeps them and drops the geometry, rather than
 * dropping the overlay entirely. Before issue #4495 the caller simply stopped
 * rendering on a refused signature, so one unsupported setting blanked the
 * holds on every climb — the opposite of the "falls back to default rendering"
 * this code has always claimed.
 *
 * The signature must stay in lock-step with the overrides it describes: it is
 * the cache key, so returning a degraded config under the full signature would
 * persist wrong pixels under a key a capable renderer later reuses.
 */
export function resolveEffectiveRenderOverrides(
  colors: HoldColorOverrides,
  shapes: HoldShapeOverrides,
  brushThickness: number,
  shapeSize: number,
  renderSignature: string,
): EffectiveRenderOverrides {
  if (!unsupportedRenderSignatures.has(renderSignature)) {
    return { signature: renderSignature, colors, shapes, brushThickness, shapeSize };
  }

  const colorSignature = buildHoldColorOverrideSignature(colors);
  if (colorSignature !== renderSignature && !unsupportedRenderSignatures.has(colorSignature)) {
    return {
      signature: colorSignature,
      colors,
      shapes: EMPTY_HOLD_SHAPE_OVERRIDES,
      brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
      shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
    };
  }

  // Colours alone were refused too (or there were none to keep). Fall all the
  // way back to the board's own palette — DEFAULT_HOLD_COLOR_SIGNATURE is never
  // recorded as unsupported, so this always renders something.
  return {
    signature: DEFAULT_HOLD_COLOR_SIGNATURE,
    colors: EMPTY_HOLD_COLOR_OVERRIDES,
    shapes: EMPTY_HOLD_SHAPE_OVERRIDES,
    brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
    shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
  };
}

/**
 * The climber's marker colours and shapes as the board actually draws them:
 * their stored choices, less anything the installed renderer refused. Follows
 * each new refusal, the same way the board does.
 */
export function useEffectiveHoldMarkers(): { colors: HoldColorOverrides; shapes: HoldShapeOverrides } {
  const { overrides, shapes, brushThickness, shapeSize, renderSignature } = useHoldColorOverrides();
  const unsupportedRevision = useSyncExternalStore(
    subscribeToUnsupportedSignatures,
    getUnsupportedSignatureRevision,
    getUnsupportedSignatureRevision,
  );
  return useMemo(() => {
    // Re-resolve whenever the renderer refuses another signature.
    void unsupportedRevision;
    const effective = resolveEffectiveRenderOverrides(overrides, shapes, brushThickness, shapeSize, renderSignature);
    return { colors: effective.colors, shapes: effective.shapes };
  }, [overrides, shapes, brushThickness, shapeSize, renderSignature, unsupportedRevision]);
}

/** Test-only handles. */
export const _unsupportedRenderSignaturesForTests = unsupportedRenderSignatures;
