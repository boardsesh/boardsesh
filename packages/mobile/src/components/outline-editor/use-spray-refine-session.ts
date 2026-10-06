import { useCallback, useMemo, useRef, useState } from 'react';
import type { BrushMode, BrushRejection } from '@boardsesh/board-art-geometry/brush';
import { useBrushSession } from './use-brush-session';
import {
  fromBrushFrame,
  holdFromRefinedOutline,
  refineFrameFor,
  refineStartOutline,
  strokeKeepingLargestPiece,
  toBrushFrame,
  type RefineFrame,
} from './spray-refine';
import type { HoldFromStrokeResult, HoldGeometry } from './spray-hold-tools';
import type { StrokeRejection } from './stroke';

/** Strokes Refine can take back, one at a time, before the oldest is forgotten. */
export const MAX_REFINE_UNDO = 20;

/** The brush session's boundary kind, so a refine never shares a bitmap with anything else. */
const REFINE_EDIT_KIND = 'spray-refine';

/** Why a stroke was not kept. `no-change` is a stroke that painted nothing: not an error. */
export type RefineRejection = Exclude<BrushRejection, 'anchor-erased'> | StrokeRejection;

export type RefineStrokeOutcome =
  | {
      ok: true;
      /**
       * Pieces the stroke cut off and the session dropped. Non-zero is worth
       * saying out loud: the climber painted something that was not kept.
       */
      droppedPieces: number;
    }
  | { ok: false; reason: RefineRejection };

/** What the screen draws while a hold is being refined. */
export type RefineView = {
  holdId: number;
  /** The area as it stands, in board px, flat and implicitly closed. */
  outlineBoardPx: number[];
  /** Strokes the bar's Undo can still take back (the stack keeps the last {@link MAX_REFINE_UNDO}). */
  strokeCount: number;
  /** The area differs from where the session started: leaving now would lose work. */
  changed: boolean;
  /** The brush frame, for the brush-size floor. */
  frame: RefineFrame;
};

type UndoEntry = {
  outlineBrushPx: number[];
  /** The brush session's bitmap before the stroke, or null when it had none. */
  cells: Uint8Array | null;
  anchorX: number;
  anchorY: number;
};

type Session = {
  holdId: number;
  frame: RefineFrame;
  /** The hold's radius in the brush frame, which bounds the engine's bitmap. */
  holdRadius: number;
  outlineBrushPx: number[];
  /** Where the area stays attached, in the brush frame. Starts at the hold's centre. */
  anchorX: number;
  anchorY: number;
  undo: UndoEntry[];
  /**
   * Strokes kept minus strokes undone. Not `undo.length`: the stack forgets its
   * oldest entries, and an area changed by a forgotten stroke is still changed.
   */
  netStrokes: number;
};

export type SprayRefineSession = {
  /** Null when nothing is being refined. */
  view: RefineView | null;
  /** Open a hold: its outline, or its circle, becomes the area to brush. */
  start: (hold: HoldGeometry & { id: number }) => void;
  /** One stroke, in board px. Kept only when the result is still a storable hold. */
  applyStroke: (strokeBoardPx: number[], brushRadiusBoardPx: number, mode: BrushMode) => RefineStrokeOutcome;
  /** Take back the last stroke. False when there is none. */
  undo: () => boolean;
  /**
   * End the session. The refined hold, ready for ONE `SET_OUTLINE`, or null
   * when no stroke was kept (nothing to commit).
   */
  finish: () => HoldFromStrokeResult | null;
  /** End the session and throw every stroke away. */
  cancel: () => void;
};

/**
 * One hold's Refine session: the shared brush session (`use-brush-session.ts`,
 * unchanged from the catalogue editor) driven in the spray adapter's frame, with
 * a per-stroke undo stack on top.
 *
 * Each stroke is checked as a storable HOLD before it is kept — centre, radius
 * and the ring contract, via `holdFromRefinedOutline` — so the area on screen is
 * always one Done can commit, and Done never has to refuse.
 *
 * Undo rolls back the brush session's bitmap with the ring, for the reason
 * `useBrushSession.snapshot` gives: later strokes compose onto the bitmap, so
 * restoring the ring alone would paint the next stroke over the undone one. The
 * stack keeps {@link MAX_REFINE_UNDO} entries, each a copy of the bitmap (about
 * 75 kB for a typical hold, 260 kB at worst).
 *
 * The session lives in refs; only the area and the stroke count are state,
 * because they are all the screen draws.
 */
export function useSprayRefineSession(): SprayRefineSession {
  const brush = useBrushSession();
  const sessionRef = useRef<Session | null>(null);
  const [view, setView] = useState<RefineView | null>(null);

  const publish = useCallback((session: Session | null) => {
    setView(
      session
        ? {
            holdId: session.holdId,
            outlineBoardPx: fromBrushFrame(session.outlineBrushPx, session.frame),
            strokeCount: session.undo.length,
            changed: session.netStrokes > 0,
            frame: session.frame,
          }
        : null,
    );
  }, []);

  const start = useCallback<SprayRefineSession['start']>(
    (hold) => {
      brush.reset();
      const frame = refineFrameFor(hold);
      const session: Session = {
        holdId: hold.id,
        frame,
        holdRadius: hold.r * frame.scale,
        outlineBrushPx: toBrushFrame(refineStartOutline(hold), frame),
        anchorX: 0,
        anchorY: 0,
        undo: [],
        netStrokes: 0,
      };
      sessionRef.current = session;
      publish(session);
    },
    [brush, publish],
  );

  const applyStroke = useCallback<SprayRefineSession['applyStroke']>(
    (strokeBoardPx, brushRadiusBoardPx, mode) => {
      const session = sessionRef.current;
      if (!session || strokeBoardPx.length < 2) return { ok: false, reason: 'no-change' };
      const { frame, holdId, holdRadius, anchorX, anchorY } = session;
      const strokeBrushPx = toBrushFrame(strokeBoardPx, frame);
      const brushRadius = brushRadiusBoardPx * frame.scale;
      const before = brush.snapshot();

      let outlineBrushPx: number[];
      let droppedPieces: number;
      let nextAnchorX = anchorX;
      let nextAnchorY = anchorY;
      let reanchored = false;
      const outcome = brush.applyStroke({
        placementId: holdId,
        editKind: REFINE_EDIT_KIND,
        hold: { id: holdId, cx: anchorX, cy: anchorY, r: holdRadius },
        baseOutlineBoardPx: session.outlineBrushPx,
        strokeBoardPx: strokeBrushPx,
        brushRadiusBoardPx: brushRadius,
        mode,
      });
      if (outcome.ok) {
        outlineBrushPx = outcome.outlineBoardPx;
        droppedPieces = outcome.droppedPieces;
      } else if (outcome.reason === 'anchor-erased') {
        // The stroke erased the middle. The session restored its bitmap; redo
        // the stroke keeping the biggest piece, and move the anchor onto it.
        const largest = strokeKeepingLargestPiece({
          outlineBrushPx: session.outlineBrushPx,
          anchorX,
          anchorY,
          holdRadius,
          strokeBrushPx,
          brushRadius,
          mode,
        });
        if (!largest.ok)
          return { ok: false, reason: largest.reason === 'anchor-erased' ? 'nothing-left' : largest.reason };
        outlineBrushPx = largest.outlineBrushPx;
        droppedPieces = largest.droppedPieces;
        nextAnchorX = largest.anchorX;
        nextAnchorY = largest.anchorY;
        reanchored = true;
      } else {
        return { ok: false, reason: outcome.reason };
      }

      const [anchorBoardX, anchorBoardY] = fromBrushFrame([nextAnchorX, nextAnchorY], frame);
      const checked = holdFromRefinedOutline(fromBrushFrame(outlineBrushPx, frame), {
        x: anchorBoardX,
        y: anchorBoardY,
      });
      if (!checked.ok) {
        // The brush session already kept this stroke's bitmap; put it back.
        if (!reanchored) brush.restore(before);
        return { ok: false, reason: checked.reason };
      }
      // A moved anchor needs a bitmap framed round it: the next stroke reseeds
      // from the ring just kept.
      if (reanchored) brush.reset();

      session.undo.push({ outlineBrushPx: session.outlineBrushPx, cells: before, anchorX, anchorY });
      if (session.undo.length > MAX_REFINE_UNDO) session.undo.shift();
      session.outlineBrushPx = outlineBrushPx;
      session.anchorX = nextAnchorX;
      session.anchorY = nextAnchorY;
      session.netStrokes += 1;
      publish(session);
      return { ok: true, droppedPieces };
    },
    [brush, publish],
  );

  const undo = useCallback(() => {
    const session = sessionRef.current;
    const entry = session?.undo.pop();
    if (!session || !entry) return false;
    // Undoing an erase that moved the anchor: the brush session's bitmap (if a
    // refused stroke has seeded one since) is framed round the NEW anchor, and
    // `restore` only checks the length, so a snapshot framed round the old one
    // could land shifted. Start clean instead; the next stroke reseeds from the ring.
    const anchorMoves = entry.anchorX !== session.anchorX || entry.anchorY !== session.anchorY;
    session.outlineBrushPx = entry.outlineBrushPx;
    session.anchorX = entry.anchorX;
    session.anchorY = entry.anchorY;
    session.netStrokes -= 1;
    // Otherwise a bitmap from another frame (a reseed since) does not fit and
    // clears the session itself, with the same reseed on the next stroke.
    if (anchorMoves) brush.reset();
    else brush.restore(entry.cells);
    publish(session);
    return true;
  }, [brush, publish]);

  const cancel = useCallback(() => {
    sessionRef.current = null;
    brush.reset();
    publish(null);
  }, [brush, publish]);

  const finish = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    brush.reset();
    publish(null);
    if (!session || session.netStrokes === 0) return null;
    const [anchorBoardX, anchorBoardY] = fromBrushFrame([session.anchorX, session.anchorY], session.frame);
    return holdFromRefinedOutline(fromBrushFrame(session.outlineBrushPx, session.frame), {
      x: anchorBoardX,
      y: anchorBoardY,
    });
  }, [brush, publish]);

  return useMemo(
    () => ({ view, start, applyStroke, undo, finish, cancel }),
    [view, start, applyStroke, undo, finish, cancel],
  );
}
