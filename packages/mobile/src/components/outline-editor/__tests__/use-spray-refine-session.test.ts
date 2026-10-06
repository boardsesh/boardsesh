// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import { MAX_REFINE_UNDO, planRefineExit, useSprayRefineSession } from '../use-spray-refine-session';
import { polygonCentroidAndArea, toRingPoints } from '../spray-hold-tools';

/** A plain circle on a 2048 px photo, about the size the editor's median gives. */
const CIRCLE = { id: 7, cx: 600, cy: 400, r: 40, outline: null };

function areaOf(flat: number[]): number {
  return polygonCentroidAndArea(toRingPoints(flat)).area;
}

function openSession() {
  const hook = renderHook(useSprayRefineSession);
  act(() => hook.result.current.start(CIRCLE));
  return hook;
}

describe('useSprayRefineSession', () => {
  it('opens a plain circle as an area', () => {
    const hook = openSession();
    const view = hook.result.current.view;
    expect(view?.holdId).toBe(7);
    expect(view?.strokeCount).toBe(0);
    expect(areaOf(view?.outlineBoardPx ?? [])).toBeCloseTo(Math.PI * 1600, -2);
  });

  it('adds and erases, and keeps every step a storable hold', () => {
    const hook = openSession();
    const startArea = areaOf(hook.result.current.view?.outlineBoardPx ?? []);
    act(() => {
      // A dab hanging off the right edge.
      expect(hook.result.current.applyStroke([640, 400, 652, 400], 8, 'add')).toEqual({
        ok: true,
        droppedPieces: 0,
        reachedLimit: false,
      });
    });
    const grown = hook.result.current.view?.outlineBoardPx ?? [];
    expect(areaOf(grown)).toBeGreaterThan(startArea);
    expect(pointInRing(grown, 655, 400)).toBe(true);

    act(() => {
      expect(hook.result.current.applyStroke([570, 360, 570, 440], 6, 'erase').ok).toBe(true);
    });
    const trimmed = hook.result.current.view?.outlineBoardPx ?? [];
    expect(pointInRing(trimmed, 565, 400)).toBe(false);
    expect(hook.result.current.view?.strokeCount).toBe(2);
  });

  it('undoes one stroke at a time, back to the start', () => {
    const hook = openSession();
    const start = hook.result.current.view?.outlineBoardPx;
    act(() => {
      hook.result.current.applyStroke([640, 400, 652, 400], 8, 'add');
    });
    const afterFirst = hook.result.current.view?.outlineBoardPx;
    act(() => {
      hook.result.current.applyStroke([600, 440, 600, 452], 8, 'add');
    });
    act(() => {
      expect(hook.result.current.undo()).toBe(true);
    });
    expect(hook.result.current.view?.outlineBoardPx).toEqual(afterFirst);
    act(() => {
      expect(hook.result.current.undo()).toBe(true);
    });
    expect(hook.result.current.view?.outlineBoardPx).toEqual(start);
    act(() => {
      expect(hook.result.current.undo()).toBe(false);
    });
  });

  it('paints the same result after an undo as without the undone stroke', () => {
    const edited = openSession();
    const fresh = openSession();
    act(() => {
      edited.result.current.applyStroke([640, 400, 652, 400], 8, 'add');
      edited.result.current.undo();
    });
    act(() => {
      edited.result.current.applyStroke([600, 440, 600, 452], 8, 'add');
      fresh.result.current.applyStroke([600, 440, 600, 452], 8, 'add');
    });
    expect(edited.result.current.view?.outlineBoardPx).toEqual(fresh.result.current.view?.outlineBoardPx);
  });

  it('refuses an erase that would leave nothing, and leaves the area alone', () => {
    const hook = openSession();
    const before = hook.result.current.view?.outlineBoardPx;
    act(() => {
      expect(hook.result.current.applyStroke([600, 400, 601, 400], 120, 'erase')).toEqual({
        ok: false,
        reason: 'nothing-left',
        reachedLimit: false,
      });
    });
    expect(hook.result.current.view?.outlineBoardPx).toEqual(before);
    expect(hook.result.current.view?.strokeCount).toBe(0);
  });

  it('keeps the piece with the hold in it when an erase cuts a lobe off', () => {
    const hook = openSession();
    act(() => {
      // Grow a lobe out to the right, then cut it off at the neck.
      hook.result.current.applyStroke([640, 400, 700, 400], 10, 'add');
    });
    act(() => {
      expect(hook.result.current.applyStroke([665, 370, 665, 430], 6, 'erase')).toEqual({
        ok: true,
        droppedPieces: 1,
        reachedLimit: false,
      });
    });
    const kept = hook.result.current.view?.outlineBoardPx ?? [];
    expect(pointInRing(kept, 600, 400)).toBe(true);
    expect(pointInRing(kept, 690, 400)).toBe(false);
  });

  it('moves the hold when the middle is erased, keeping the biggest piece', () => {
    const hook = openSession();
    act(() => {
      // Widen to the right, then erase a band through the old centre.
      hook.result.current.applyStroke([650, 380, 650, 420], 20, 'add');
    });
    act(() => {
      expect(hook.result.current.applyStroke([600, 340, 600, 460], 20, 'erase').ok).toBe(true);
    });
    let committed: ReturnType<typeof hook.result.current.finish> = null;
    act(() => {
      committed = hook.result.current.finish();
    });
    expect(committed).not.toBeNull();
    const result = committed as unknown as { ok: true; hold: { cx: number; outline: number[] } };
    expect(result.ok).toBe(true);
    expect(result.hold.cx).toBeGreaterThan(610);
  });

  it('undoing an erase that moved the hold paints the next stroke as if it never happened', () => {
    const edited = openSession();
    const fresh = openSession();
    act(() => {
      edited.result.current.applyStroke([650, 380, 650, 420], 20, 'add');
      fresh.result.current.applyStroke([650, 380, 650, 420], 20, 'add');
    });
    act(() => {
      // Through the middle: the anchor moves onto the bigger piece.
      expect(edited.result.current.applyStroke([600, 340, 600, 460], 20, 'erase').ok).toBe(true);
    });
    act(() => {
      // Refused (paints nothing), but seeds a bitmap round the moved anchor.
      expect(edited.result.current.applyStroke([640, 400, 641, 400], 4, 'add')).toEqual({
        ok: false,
        reason: 'no-change',
        reachedLimit: false,
      });
      expect(edited.result.current.undo()).toBe(true);
    });
    expect(edited.result.current.view?.outlineBoardPx).toEqual(fresh.result.current.view?.outlineBoardPx);
    act(() => {
      edited.result.current.applyStroke([600, 440, 600, 452], 8, 'add');
      fresh.result.current.applyStroke([600, 440, 600, 452], 8, 'add');
    });
    // The edited session reseeds its bitmap from the ring (a fresh frame), so
    // the two agree to the raster's own noise rather than to the bit.
    const editedRing = polygonCentroidAndArea(toRingPoints(edited.result.current.view?.outlineBoardPx ?? []));
    const freshRing = polygonCentroidAndArea(toRingPoints(fresh.result.current.view?.outlineBoardPx ?? []));
    expect(Math.abs(editedRing.cx - freshRing.cx)).toBeLessThan(1);
    expect(Math.abs(editedRing.cy - freshRing.cy)).toBeLessThan(1);
    expect(Math.abs(editedRing.area / freshRing.area - 1)).toBeLessThan(0.03);
  });

  it('undo across a moved anchor never paints onto a bitmap framed round the new one', () => {
    // Erasing bare wall far off the hold paints nothing but grows the brush
    // bitmap to its 4-radius cap. Done either side of the anchor move, both
    // bitmaps are the same size, so only the frame's origin tells them apart.
    const farErase = [800, 400, 801, 400];
    const centroidOf = (flat: number[]) => {
      const { cx, cy } = polygonCentroidAndArea(toRingPoints(flat));
      return { cx, cy };
    };
    const edited = openSession();
    act(() => {
      edited.result.current.applyStroke([650, 380, 650, 420], 20, 'add');
      edited.result.current.applyStroke(farErase, 4, 'erase');
    });
    const beforeMove = edited.result.current.view?.outlineBoardPx ?? [];
    act(() => {
      expect(edited.result.current.applyStroke([600, 340, 600, 460], 20, 'erase').ok).toBe(true);
      edited.result.current.applyStroke(farErase, 4, 'erase');
      expect(edited.result.current.undo()).toBe(true);
    });
    act(() => {
      edited.result.current.applyStroke([600, 440, 600, 446], 4, 'add');
    });
    const after = centroidOf(edited.result.current.view?.outlineBoardPx ?? []);
    const before = centroidOf(beforeMove);
    expect(Math.abs(after.cx - before.cx)).toBeLessThan(3);
    expect(Math.abs(after.cy - before.cy)).toBeLessThan(3);
  });

  it('counts as changed while a stroke is kept', () => {
    const hook = openSession();
    expect(hook.result.current.view?.changed).toBe(false);
    act(() => {
      hook.result.current.applyStroke([640, 400, 652, 400], 8, 'add');
    });
    expect(hook.result.current.view?.changed).toBe(true);
    act(() => {
      hook.result.current.undo();
    });
    expect(hook.result.current.view?.changed).toBe(false);
  });

  it('commits one storable hold on finish, and nothing when no stroke was kept', () => {
    const untouched = openSession();
    act(() => {
      expect(untouched.result.current.finish()).toBeNull();
    });
    expect(untouched.result.current.view).toBeNull();

    const hook = openSession();
    act(() => {
      hook.result.current.applyStroke([640, 400, 652, 400], 8, 'add');
    });
    let committed: ReturnType<typeof hook.result.current.finish> = null;
    act(() => {
      committed = hook.result.current.finish();
    });
    const result = committed as unknown as { ok: boolean; hold: { cx: number; r: number; outline: number[] } };
    expect(result.ok).toBe(true);
    expect(isValidOutlineRing(result.hold.outline)).toBe(true);
    // The added dab pulls the centre right and the hold grows.
    expect(result.hold.cx).toBeGreaterThan(600);
    expect(result.hold.r).toBeGreaterThan(40);
    expect(hook.result.current.view).toBeNull();
  });

  it('still commits after the undo stack has forgotten its oldest strokes', () => {
    const hook = openSession();
    act(() => {
      for (let step = 0; step < MAX_REFINE_UNDO + 3; step += 1) {
        const angle = (step / (MAX_REFINE_UNDO + 3)) * Math.PI * 2;
        const x = 600 + Math.cos(angle) * 42;
        const y = 400 + Math.sin(angle) * 42;
        hook.result.current.applyStroke([x, y, x + 1, y], 4, 'add');
      }
    });
    act(() => {
      while (hook.result.current.undo()) {
        // Undo everything the stack still remembers.
      }
    });
    let committed: ReturnType<typeof hook.result.current.finish> = null;
    act(() => {
      committed = hook.result.current.finish();
    });
    expect(committed).not.toBeNull();
  });

  it('says when Add reaches past the furthest a hold can grow', () => {
    const hook = openSession();
    // 4 radii of a 40 px hold is 160 px from the centre; this dab reaches 175.
    let outcome: ReturnType<typeof hook.result.current.applyStroke> | null = null;
    act(() => {
      outcome = hook.result.current.applyStroke([630, 400, 770, 400], 6, 'add');
    });
    expect(outcome).toMatchObject({ ok: true, reachedLimit: true });
    // Erasing out there clips nothing that matters, so it says nothing.
    act(() => {
      outcome = hook.result.current.applyStroke([780, 400, 781, 400], 6, 'erase');
    });
    expect(outcome).toMatchObject({ reachedLimit: false });
  });

  it('result() reads the hold without ending the session', () => {
    const hook = openSession();
    act(() => {
      hook.result.current.applyStroke([640, 400, 652, 400], 8, 'add');
    });
    const peeked = hook.result.current.result();
    expect(peeked?.ok).toBe(true);
    expect(hook.result.current.view?.changed).toBe(true);
    let finished: ReturnType<typeof hook.result.current.finish> = null;
    act(() => {
      finished = hook.result.current.finish();
    });
    expect(finished).toEqual(peeked);
  });

  it('cancel throws the strokes away', () => {
    const hook = openSession();
    act(() => {
      hook.result.current.applyStroke([640, 400, 652, 400], 8, 'add');
      hook.result.current.cancel();
    });
    expect(hook.result.current.view).toBeNull();
    act(() => {
      expect(hook.result.current.finish()).toBeNull();
    });
  });
});

describe('planRefineExit', () => {
  const kept = { ok: true as const, hold: { cx: 1, cy: 2, r: 3, outline: [1, 0, 0, 1, -1, 0] } };
  const base = { keep: true, result: kept, holdExists: true, canEdit: true, overCap: false };

  it('commits a kept area', () => {
    expect(planRefineExit(base)).toEqual({ kind: 'commit', hold: kept.hold });
  });

  it('leaves with nothing to commit when no stroke is kept', () => {
    expect(planRefineExit({ ...base, result: null })).toEqual({ kind: 'unchanged' });
  });

  it('discards on Cancel, or when the hold is gone', () => {
    expect(planRefineExit({ ...base, keep: false })).toEqual({ kind: 'discard' });
    expect(planRefineExit({ ...base, holdExists: false })).toEqual({ kind: 'discard' });
  });

  it('stays in Refine, strokes intact, whenever a commit cannot happen', () => {
    expect(planRefineExit({ ...base, result: { ok: false, reason: 'out-of-bounds' } })).toEqual({
      kind: 'stay',
      reason: 'refused',
      rejection: 'out-of-bounds',
    });
    expect(planRefineExit({ ...base, canEdit: false })).toEqual({ kind: 'stay', reason: 'locked' });
    expect(planRefineExit({ ...base, overCap: true })).toEqual({ kind: 'stay', reason: 'cap' });
  });
});
