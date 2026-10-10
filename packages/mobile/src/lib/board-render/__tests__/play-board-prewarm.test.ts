import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPlayBoardPrewarmForTests,
  getPlayBoardPrewarmTarget,
  rememberPlayOverlayWidth,
  requestPlayBoardPrewarm,
  subscribeToPlayBoardPrewarm,
} from '../play-board-prewarm';

const KILTER = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '26,27' };
const TENSION = { boardName: 'tension' as const, layoutId: 9, sizeId: 1, setIds: '8,9' };

describe('play board prewarm', () => {
  beforeEach(() => {
    _resetPlayBoardPrewarmForTests();
  });

  // A render at a guessed width lands under a cache key the drawer never looks
  // up, so until the carousel has measured this board there is nothing to warm.
  it('does nothing until the play drawer has measured this board', () => {
    const listener = vi.fn();
    subscribeToPlayBoardPrewarm(listener);
    requestPlayBoardPrewarm(KILTER, 'p1r12p2r13');
    expect(getPlayBoardPrewarmTarget()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('names the tapped climb at the measured width', () => {
    rememberPlayOverlayWidth(KILTER, 1011);
    requestPlayBoardPrewarm(KILTER, 'p1r12p2r13');
    expect(getPlayBoardPrewarmTarget()).toEqual({ ...KILTER, frames: 'p1r12p2r13', renderWidth: 1011 });
  });

  it('keeps one width per board', () => {
    rememberPlayOverlayWidth(KILTER, 1011);
    requestPlayBoardPrewarm(TENSION, 'p1r12');
    expect(getPlayBoardPrewarmTarget()).toBeNull();
    rememberPlayOverlayWidth(TENSION, 900);
    requestPlayBoardPrewarm(TENSION, 'p1r12');
    expect(getPlayBoardPrewarmTarget()?.renderWidth).toBe(900);
  });

  it('notifies once per new target and keeps the snapshot identity on a repeat tap', () => {
    rememberPlayOverlayWidth(KILTER, 1011);
    const listener = vi.fn();
    const unsubscribe = subscribeToPlayBoardPrewarm(listener);
    requestPlayBoardPrewarm(KILTER, 'p1r12');
    const first = getPlayBoardPrewarmTarget();
    requestPlayBoardPrewarm(KILTER, 'p1r12');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPlayBoardPrewarmTarget()).toBe(first);

    requestPlayBoardPrewarm(KILTER, 'p3r14');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    requestPlayBoardPrewarm(KILTER, 'p5r15');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('follows a re-measured width', () => {
    rememberPlayOverlayWidth(KILTER, 1011);
    requestPlayBoardPrewarm(KILTER, 'p1r12');
    rememberPlayOverlayWidth(KILTER, 960);
    requestPlayBoardPrewarm(KILTER, 'p1r12');
    expect(getPlayBoardPrewarmTarget()?.renderWidth).toBe(960);
  });

  it('ignores a climb with no holds', () => {
    rememberPlayOverlayWidth(KILTER, 1011);
    requestPlayBoardPrewarm(KILTER, '');
    expect(getPlayBoardPrewarmTarget()).toBeNull();
  });
});
