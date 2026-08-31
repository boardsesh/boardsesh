import { useCallback, useMemo, useRef } from 'react';
import {
  keepAnchoredComponent,
  maskHalfSpan,
  maskToRing,
  outlineToMask,
  stampBrushStroke,
  strokeReachFromAnchor,
  type BrushMask,
  type BrushMode,
  type BrushRejection,
} from '@boardsesh/board-art-geometry/brush';
import type { BoardHoldTarget } from '../../lib/create-board-holds';

/**
 * One hold's working bitmap, held across every brush stroke it receives.
 *
 * The mask is the session's source of truth, not the committed ring. Deriving a
 * fresh bitmap from the last committed ring on every stroke would pay the
 * ring-to-raster-to-ring decimation cost again each time, and the costs do not
 * cancel: measured over 20 strokes on 60 holds, re-rasterising each time drifts
 * to -4.7% of area in the worst case while one persistent mask stays at -2.4%,
 * which is by construction the cost of the single round trip it actually did.
 *
 * Scoped to one placement and one boundary kind. Anything that changes either —
 * picking a different hold, switching outer/inner edge, saving, reverting — drops
 * the mask, so a stale bitmap can never be brushed onto the wrong outline.
 */
export type BrushStrokeOutcome =
  | { ok: true; outlineBoardPx: number[]; droppedPieces: number }
  | { ok: false; reason: BrushRejection };

type SessionKey = { placementId: number; editKind: string };

export type BrushSession = {
  /**
   * Apply one stroke and hand back the edited outline in board px.
   *
   * `baseOutlineBoardPx` seeds the mask on the first stroke of a session and is
   * ignored afterwards, which is the whole point: later strokes compose onto the
   * bitmap the earlier ones painted.
   */
  applyStroke: (params: {
    placementId: number;
    editKind: string;
    hold: BoardHoldTarget;
    baseOutlineBoardPx: number[];
    strokeBoardPx: number[];
    brushRadiusBoardPx: number;
    mode: BrushMode;
  }) => BrushStrokeOutcome;
  /** Forget the bitmap. Cheap, and safe to call when nothing is open. */
  reset: () => void;
};

/**
 * Hold the brush's bitmap for whichever placement is being edited.
 *
 * A ref rather than state: nothing renders from the mask (the screen renders the
 * ring the mask produced), and a megabyte of `Uint8Array` in state would make
 * every stroke a re-render of the whole editor.
 */
export function useBrushSession(): BrushSession {
  const maskRef = useRef<BrushMask | null>(null);
  const keyRef = useRef<SessionKey | null>(null);

  const reset = useCallback(() => {
    maskRef.current = null;
    keyRef.current = null;
  }, []);

  const applyStroke = useCallback<BrushSession['applyStroke']>(
    ({ placementId, editKind, hold, baseOutlineBoardPx, strokeBoardPx, brushRadiusBoardPx, mode }) => {
      const key = keyRef.current;
      const sameSession = key !== null && key.placementId === placementId && key.editKind === editKind;
      // Reseed on a new session, and also when this stroke reaches outside the
      // frame the session was sized for. Without the second test an Add session
      // can only grow a hold about one radius before every further outward
      // stroke is clipped to nothing — and a clipped stroke changes no cells, so
      // the user would be told "that is already inside the outline" for a stroke
      // that was entirely outside it. Reseeding costs one round trip through the
      // raster, which is the right price for the stroke that needs it.
      const reach = strokeReachFromAnchor(strokeBoardPx, hold.cx, hold.cy, brushRadiusBoardPx);
      const outgrown = maskRef.current !== null && reach > maskHalfSpan(maskRef.current);
      if (!sameSession || maskRef.current === null || outgrown) {
        // `baseOutlineBoardPx` is the caller's latest committed ring, so
        // reseeding from it keeps the edits made so far. It costs one extra
        // round trip through the raster, on the one stroke that needs it.
        maskRef.current = outlineToMask({
          outlineBoardPx: baseOutlineBoardPx,
          anchorX: hold.cx,
          anchorY: hold.cy,
          holdRadius: hold.r,
          reachBoardPx: reach,
        });
        keyRef.current = { placementId, editKind };
      }

      const mask = maskRef.current;
      // Snapshot before painting: a stroke that ends up rejected must leave the
      // session exactly as it was, or the next stroke composes onto a bitmap the
      // user was told did not take.
      const before = mask.cells.slice();
      const changed = stampBrushStroke(mask, strokeBoardPx, brushRadiusBoardPx, mode);
      if (changed === 0) {
        return { ok: false, reason: 'no-change' };
      }

      const anchored = keepAnchoredComponent(mask);
      if (!anchored.ok) {
        mask.cells.set(before);
        return { ok: false, reason: anchored.reason };
      }

      const traced = maskToRing(anchored.cells, mask);
      if (!traced.ok) {
        mask.cells.set(before);
        return traced;
      }

      // Keep the pruned bitmap, not the painted one. Offcuts the anchor rule
      // dropped are gone from the outline, so leaving them in the mask would
      // resurrect them the moment a later stroke reconnected one.
      mask.cells.set(anchored.cells);
      return { ok: true, outlineBoardPx: traced.outlineBoardPx, droppedPieces: anchored.droppedPieces };
    },
    [],
  );

  // Memoized: this object is read by `clearDraft`, `handleStrokeEnd` and the
  // render props they feed, so a fresh identity every render would churn the
  // `React.memo`'d board and draw overlay for nothing.
  return useMemo(() => ({ applyStroke, reset }), [applyStroke, reset]);
}
