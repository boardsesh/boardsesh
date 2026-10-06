// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import { MAX_REFINE_UNDO, useSprayRefineSession } from '../use-spray-refine-session';
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
      expect(hook.result.current.applyStroke([640, 400, 652, 400], 8, 'add')).toEqual({ ok: true, droppedPieces: 0 });
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
      expect(hook.result.current.applyStroke([595, 340, 595, 460], 12, 'erase').ok).toBe(true);
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
