// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import {
  SCROLL_EDGE_SLACK,
  ScrollEdgeListReset,
  createScrollEdgeBackdrop,
  useScrollEdgeBackdrop,
  useScrolledUnder,
} from '../use-scroll-edge-backdrop';

function scrollEvent(
  offsetY: number,
  velocityY?: number,
  targetOffsetY?: number,
): NativeSyntheticEvent<NativeScrollEvent> {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offsetY },
      ...(velocityY === undefined ? {} : { velocity: { x: 0, y: velocityY } }),
      ...(targetOffsetY === undefined ? {} : { targetContentOffset: { x: 0, y: targetOffsetY } }),
    },
  } as NativeSyntheticEvent<NativeScrollEvent>;
}

// A phone under a UIKit header: the bar is 106 pt compact and 158 pt with its
// large title out, so the list rests at -106 or -158.
const COMPACT_TOP = -106;
const EXPANDED_TOP = -158;

/** A store as the chrome last drew the controls, with every change counted. */
function edgeAt(topOffset: number) {
  const edge = createScrollEdgeBackdrop();
  edge.setTopOffset(topOffset);
  const changes = vi.fn();
  edge.subscribe(changes);
  let latestOffset = topOffset;
  const scrollTo = (...offsets: number[]) => {
    for (const offset of offsets) {
      latestOffset = offset;
      edge.listProps.onScroll(scrollEvent(offset));
    }
  };
  const beginDrag = (offset: number) => {
    latestOffset = offset;
    edge.listProps.onScrollBeginDrag(scrollEvent(offset));
  };
  const endDrag = (velocityY?: number, targetOffsetY?: number) =>
    edge.listProps.onScrollEndDrag(scrollEvent(latestOffset, velocityY, targetOffsetY));
  /** Finger down at `from`, dragged through `through`, lifted with no fling. */
  const drag = (from: number, ...through: number[]) => {
    beginDrag(from);
    scrollTo(...through);
    endDrag();
  };
  return { edge, changes, scrollTo, beginDrag, endDrag, drag, scrolledUnder: () => edge.isScrolledUnder() };
}

describe('createScrollEdgeBackdrop', () => {
  it('starts at rest, before the list has scrolled at all', () => {
    expect(edgeAt(COMPACT_TOP).scrolledUnder()).toBe(false);
  });

  it('tells its subscribers once when rows pass under the controls, and once when they leave', () => {
    const list = edgeAt(COMPACT_TOP);

    // A whole fling of scroll events, every one of them past the top.
    list.scrollTo(-100, -60, 0, 240, 900, 2400);
    expect(list.scrolledUnder()).toBe(true);
    expect(list.changes).toHaveBeenCalledTimes(1);

    list.scrollTo(900, 240, -50, COMPACT_TOP);
    expect(list.scrolledUnder()).toBe(false);
    expect(list.changes).toHaveBeenCalledTimes(2);
  });

  it('says nothing for scroll events that leave the answer unchanged', () => {
    const list = edgeAt(COMPACT_TOP);
    list.scrollTo(-106, -106.4, -105, -104.5);
    expect(list.scrolledUnder()).toBe(false);
    expect(list.changes).not.toHaveBeenCalled();
  });

  it('keeps a couple of points of slack at the resting top', () => {
    const list = edgeAt(COMPACT_TOP);
    list.scrollTo(COMPACT_TOP + SCROLL_EDGE_SLACK);
    expect(list.scrolledUnder()).toBe(false);
    list.scrollTo(COMPACT_TOP + SCROLL_EDGE_SLACK + 0.5);
    expect(list.scrolledUnder()).toBe(true);
  });

  // Overscroll and pull-to-refresh both move the offset further negative.
  it('treats the rubber-band overscroll and a pull-to-refresh as at rest', () => {
    const list = edgeAt(COMPACT_TOP);
    list.drag(COMPACT_TOP, -120, -180, -240);
    list.scrollTo(-166, -166, -130, COMPACT_TOP);
    expect(list.scrolledUnder()).toBe(false);
    expect(list.changes).not.toHaveBeenCalled();
  });

  it('turns off when a scrolled list is flung back past its top', () => {
    const list = edgeAt(COMPACT_TOP);
    list.scrollTo(300);
    expect(list.scrolledUnder()).toBe(true);
    // The bounce at the top overshoots before it settles.
    list.scrollTo(-140, -118, COMPACT_TOP);
    expect(list.scrolledUnder()).toBe(false);
  });

  // Android, Material, the web and the old floating chrome: no UIKit inset, and
  // no chrome that ever reports a top.
  it('works from a resting top of 0 where there is no UIKit header', () => {
    const edge = createScrollEdgeBackdrop();
    for (const offset of [0, 1, SCROLL_EDGE_SLACK, -40]) edge.listProps.onScroll(scrollEvent(offset));
    expect(edge.isScrolledUnder()).toBe(false);
    edge.listProps.onScroll(scrollEvent(SCROLL_EDGE_SLACK + 1));
    expect(edge.isScrolledUnder()).toBe(true);
  });

  // A search reset, a tap on the status bar: no finger, so no gesture to consult.
  it('judges a programmatic scroll against the top the chrome last drew', () => {
    const list = edgeAt(COMPACT_TOP);
    list.scrollTo(640);
    expect(list.scrolledUnder()).toBe(true);
    list.scrollTo(COMPACT_TOP);
    expect(list.scrolledUnder()).toBe(false);
  });

  describe('the top the chrome reports', () => {
    it('re-judges a list that has not moved when the controls do', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.scrollTo(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(true);

      // The bar settles at its compact height: the controls are now drawn with
      // their bottom edge exactly at the first row.
      list.edge.setTopOffset(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(false);
    });

    it('says nothing when the same top is reported again', () => {
      const list = edgeAt(COMPACT_TOP);
      list.edge.setTopOffset(COMPACT_TOP);
      expect(list.changes).not.toHaveBeenCalled();
    });

    // react-native-screens reports a height of 0 while the bar is hidden. A
    // remembered minimum would keep that reading for the life of the tab and
    // start the blur a whole bar late. Each reading replaces the last.
    it('follows the bar back after a reading taken while it was hidden', () => {
      const list = edgeAt(COMPACT_TOP);
      list.edge.setTopOffset(0);
      list.edge.setTopOffset(COMPACT_TOP);

      list.scrollTo(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(false);
      list.scrollTo(COMPACT_TOP + 20);
      expect(list.scrolledUnder()).toBe(true);
    });

    it('follows the bar when it grows back to its large title', () => {
      const list = edgeAt(COMPACT_TOP);
      list.edge.setTopOffset(EXPANDED_TOP);
      // No gesture yet: rows 30 pt past the expanded rest are under the controls.
      list.scrollTo(EXPANDED_TOP + 30);
      expect(list.scrolledUnder()).toBe(true);
    });
  });

  // JS hears the bar's height late: 100 ms after it stops on Climbs, where the
  // stack debounces it. Until then the controls stay where they were drawn.
  describe('a drag that begins at rest under a large title', () => {
    it('turns on as soon as the list has left rest, while the controls still sit at the expanded top', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(EXPANDED_TOP + 1);
      expect(list.scrolledUnder()).toBe(false);

      list.scrollTo(EXPANDED_TOP + 6, EXPANDED_TOP + 20, EXPANDED_TOP + 40);
      expect(list.scrolledUnder()).toBe(true);
      expect(list.changes).toHaveBeenCalledTimes(1);
    });

    // The controls ride up with the title, a frame or two behind it. Following
    // each height as it arrives would flip the answer every frame of the drag.
    it('stays on through the collapse however the bar height trickles in', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      for (const offset of [-150, -140, -128, -116, COMPACT_TOP]) {
        list.scrollTo(offset);
        list.edge.setTopOffset(offset);
      }
      expect(list.scrolledUnder()).toBe(true);
      expect(list.changes).toHaveBeenCalledTimes(1);
    });

    it('turns off when the list stops exactly under the collapsed bar', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.drag(EXPANDED_TOP, -140, -120, COMPACT_TOP);
      // Lifted, and the controls not yet redrawn: rows are still under them.
      expect(list.scrolledUnder()).toBe(true);

      list.edge.setTopOffset(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(false);
    });

    it.each([1.4, -1.4])('keeps the blur on through the momentum handoff at velocity %s', (velocityY) => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(-120);
      list.edge.setTopOffset(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(true);
      const changesBeforeLift = list.changes.mock.calls.length;

      list.endDrag(velocityY);
      expect(list.scrolledUnder()).toBe(true);
      list.edge.listProps.onMomentumScrollBegin();
      expect(list.scrolledUnder()).toBe(true);
      expect(list.changes).toHaveBeenCalledTimes(changesBeforeLift);

      list.scrollTo(COMPACT_TOP);
      list.edge.listProps.onMomentumScrollEnd();
      expect(list.scrolledUnder()).toBe(false);
      expect(list.changes).toHaveBeenCalledTimes(changesBeforeLift + 1);
    });

    it.each([0, undefined])('settles immediately when the lift has no momentum (%s)', (velocityY) => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(COMPACT_TOP);
      list.edge.setTopOffset(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(true);

      list.endDrag(velocityY);
      expect(list.scrolledUnder()).toBe(false);
    });

    it('settles a nonzero lift velocity whose projected target has no travel', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(COMPACT_TOP);
      list.edge.setTopOffset(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(true);

      list.endDrag(0.01, COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(false);
      // No momentum event follows this lift; later geometry still settles.
      list.edge.setTopOffset(COMPACT_TOP - 1);
      expect(list.scrolledUnder()).toBe(false);
    });

    it('uses projected travel to keep the blur through a fling without velocity', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(-120);
      list.edge.setTopOffset(COMPACT_TOP);
      const changesBeforeLift = list.changes.mock.calls.length;

      list.endDrag(undefined, 100);
      expect(list.scrolledUnder()).toBe(true);
      list.edge.listProps.onMomentumScrollBegin();
      expect(list.changes).toHaveBeenCalledTimes(changesBeforeLift);
      list.scrollTo(COMPACT_TOP);
      list.edge.listProps.onMomentumScrollEnd();
      expect(list.scrolledUnder()).toBe(false);
    });

    it('stays on through the fling that follows the drag, and settles when it stops', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.drag(EXPANDED_TOP, -140, -120);
      list.edge.listProps.onMomentumScrollBegin();
      for (const offset of [-112, COMPACT_TOP]) {
        list.scrollTo(offset);
        list.edge.setTopOffset(offset);
      }
      expect(list.scrolledUnder()).toBe(true);

      list.edge.listProps.onMomentumScrollEnd();
      expect(list.scrolledUnder()).toBe(false);
    });

    it('stays on for a list that carries on past the collapsed bar', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.drag(EXPANDED_TOP, -120, -60, 200);
      list.edge.setTopOffset(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(true);
    });

    it('turns off when the same drag comes back to rest', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(-140);
      expect(list.scrolledUnder()).toBe(true);
      list.scrollTo(EXPANDED_TOP);
      expect(list.scrolledUnder()).toBe(false);
    });
  });

  // A held pull stretches the bar, and JS can still hold that taller height after
  // the list has snapped back. Read naively, the list is then "past its top".
  describe('a pull that stretches the bar', () => {
    it('never turns the blur on, during the pull or after it', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(-190, -218);
      list.edge.setTopOffset(-218);
      list.endDrag();
      // Springs back while JS still believes the bar is 218 tall.
      list.scrollTo(-200, -180, EXPANDED_TOP);
      expect(list.scrolledUnder()).toBe(false);

      list.edge.setTopOffset(EXPANDED_TOP);
      expect(list.scrolledUnder()).toBe(false);
      expect(list.changes).not.toHaveBeenCalled();
    });

    it('keeps a zero-velocity pull bounce clear when its target travels back to rest', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(-218);
      list.edge.setTopOffset(-218);
      list.endDrag(0, EXPANDED_TOP);
      list.edge.listProps.onMomentumScrollBegin();
      list.scrollTo(-190, EXPANDED_TOP);
      list.edge.listProps.onMomentumScrollEnd();
      expect(list.scrolledUnder()).toBe(false);
      expect(list.changes).not.toHaveBeenCalled();
    });

    it('holds through a refresh that parks the list below its top', () => {
      const list = edgeAt(COMPACT_TOP);
      list.drag(COMPACT_TOP, -150, -190);
      list.scrollTo(-166, -166, -166, -140, COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(false);
    });

    it('holds when the pull began from a scrolled list', () => {
      const list = edgeAt(COMPACT_TOP);
      list.beginDrag(300);
      // Down through the top, the title out, the bar stretched.
      list.scrollTo(40, COMPACT_TOP, EXPANDED_TOP, -210);
      list.edge.setTopOffset(-210);
      list.endDrag();
      expect(list.scrolledUnder()).toBe(false);

      list.scrollTo(-180, EXPANDED_TOP);
      expect(list.scrolledUnder()).toBe(false);
    });
  });

  describe('a drag that begins with rows already under the controls', () => {
    it('is on from the start and off once the list is back at the top', () => {
      const list = edgeAt(COMPACT_TOP);
      list.scrollTo(300);
      list.beginDrag(300);
      list.scrollTo(180, 40);
      expect(list.scrolledUnder()).toBe(true);
      list.scrollTo(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(false);
    });

    // The title coming back out makes the bar grow. That must not read as rows
    // going under the controls.
    it('stays off while the title re-expands on the way down', () => {
      const list = edgeAt(COMPACT_TOP);
      list.scrollTo(300);
      list.beginDrag(300);
      list.scrollTo(COMPACT_TOP);
      const changesAtTop = list.changes.mock.calls.length;
      for (const offset of [-116, -130, -144, EXPANDED_TOP]) {
        list.scrollTo(offset);
        list.edge.setTopOffset(offset + 8);
      }
      expect(list.scrolledUnder()).toBe(false);
      expect(list.changes).toHaveBeenCalledTimes(changesAtTop);
    });
  });

  it('lets a finger down end a fling whose end event never came', () => {
    const list = edgeAt(EXPANDED_TOP);
    list.drag(EXPANDED_TOP, -140);
    list.edge.listProps.onMomentumScrollBegin();
    list.scrollTo(-120);
    list.edge.setTopOffset(-120);

    // Caught mid-fling, dragged on to the collapsed top and let go there. Were
    // the fling still counted as in flight, the lift would settle nothing.
    list.beginDrag(-120);
    list.scrollTo(COMPACT_TOP);
    list.edge.setTopOffset(COMPACT_TOP);
    expect(list.scrolledUnder()).toBe(true);
    list.endDrag();
    expect(list.scrolledUnder()).toBe(false);
  });

  describe('resetList', () => {
    it('puts a scrolled list back at rest and says so', () => {
      const list = edgeAt(COMPACT_TOP);
      list.scrollTo(500);
      list.edge.resetList();
      expect(list.scrolledUnder()).toBe(false);
      expect(list.changes).toHaveBeenCalledTimes(2);
    });

    it('forgets the last gesture, so the next list is judged on its own', () => {
      const list = edgeAt(EXPANDED_TOP);
      list.beginDrag(EXPANDED_TOP);
      list.scrollTo(-120);
      list.edge.resetList();
      list.edge.setTopOffset(COMPACT_TOP);

      // A new list, no gesture yet, exactly at the collapsed top.
      list.scrollTo(COMPACT_TOP);
      expect(list.scrolledUnder()).toBe(false);
      list.scrollTo(COMPACT_TOP + 10);
      expect(list.scrolledUnder()).toBe(true);
    });

    it('keeps the top the chrome reported: that belongs to the bar, not the list', () => {
      const list = edgeAt(COMPACT_TOP);
      list.edge.resetList();
      list.scrollTo(-60);
      expect(list.scrolledUnder()).toBe(true);
    });
  });

  describe('attachBackdrop', () => {
    it('reports a blur as listening until the last one detaches', () => {
      const edge = createScrollEdgeBackdrop();
      const changes = vi.fn();
      edge.subscribe(changes);
      expect(edge.hasBackdrop()).toBe(false);

      const detachFirst = edge.attachBackdrop();
      const detachSecond = edge.attachBackdrop();
      expect(edge.hasBackdrop()).toBe(true);
      expect(changes).toHaveBeenCalledTimes(1);

      detachFirst();
      expect(edge.hasBackdrop()).toBe(true);
      detachSecond();
      expect(edge.hasBackdrop()).toBe(false);
      expect(changes).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useScrollEdgeBackdrop (the screen that owns the list)', () => {
  const renderScreen = () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useScrollEdgeBackdrop();
    });
    return { ...hook, renders: () => renders };
  };

  it('keeps one store for the life of the screen', () => {
    const screen = renderScreen();
    const first = screen.result.current.backdrop;
    screen.rerender();
    expect(screen.result.current.backdrop).toBe(first);
  });

  // An opaque header (Material, Android, iOS before 26, Reduce Transparency,
  // Increase Contrast) never mounts a blur, so its list carries no listeners.
  it('gives the list nothing until a blur is mounted to hear it', () => {
    const screen = renderScreen();
    expect(screen.result.current.list).toBeUndefined();

    let detach = () => {};
    act(() => {
      detach = screen.result.current.backdrop.attachBackdrop();
    });
    expect(screen.result.current.list).toBe(screen.result.current.backdrop);

    act(() => detach());
    expect(screen.result.current.list).toBeUndefined();
  });

  // The screen holds the lists. Re-rendering it per frame of a scroll, or per
  // height the collapsing bar reports, re-renders every row under it.
  it('does not re-render the screen for a scroll, a flip, or the bar changing height', () => {
    const screen = renderScreen();
    act(() => {
      screen.result.current.backdrop.attachBackdrop();
    });
    const rendersWired = screen.renders();
    const { backdrop } = screen.result.current;

    act(() => {
      for (const topOffset of [-158, -150, -131, -106]) backdrop.setTopOffset(topOffset);
      for (const offset of [-106, -40, 300, 900, -106]) backdrop.listProps.onScroll(scrollEvent(offset));
    });

    expect(screen.renders()).toBe(rendersWired);
  });
});

describe('useScrolledUnder (the blur)', () => {
  it('follows the store', () => {
    const edge = createScrollEdgeBackdrop();
    const blur = renderHook(() => useScrolledUnder(edge));
    expect(blur.result.current).toBe(false);

    act(() => edge.listProps.onScroll(scrollEvent(120)));
    expect(blur.result.current).toBe(true);

    act(() => edge.listProps.onScroll(scrollEvent(0)));
    expect(blur.result.current).toBe(false);
  });

  // Chrome nobody wired to a list: a frost at rest is plain to see, bare
  // controls over rows mid-scroll are not.
  it('is always on without a store', () => {
    expect(renderHook(() => useScrolledUnder(undefined)).result.current).toBe(true);
  });
});

describe('ScrollEdgeListReset (beside the list)', () => {
  it('puts the store at rest when the list unmounts', () => {
    const edge = createScrollEdgeBackdrop();
    const list = render(createElement(ScrollEdgeListReset, { edge }));
    edge.listProps.onScroll(scrollEvent(400));
    expect(edge.isScrolledUnder()).toBe(true);

    // A loading or offline branch takes the list's place.
    list.unmount();
    expect(edge.isScrolledUnder()).toBe(false);
  });

  it('starts a newly mounted list at rest, whatever the last one left behind', () => {
    const edge = createScrollEdgeBackdrop();
    edge.listProps.onScroll(scrollEvent(400));
    render(createElement(ScrollEdgeListReset, { edge }));
    expect(edge.isScrolledUnder()).toBe(false);
  });

  it('tells the blur in the commit that swaps the list, not a frame later', () => {
    const edge = createScrollEdgeBackdrop();
    const seen: boolean[] = [];
    function Screen({ listMounted }: { listMounted: boolean }) {
      seen.push(useScrolledUnder(edge));
      return listMounted ? createElement(ScrollEdgeListReset, { edge }) : null;
    }
    const screen = render(createElement(Screen, { listMounted: true }));
    act(() => edge.listProps.onScroll(scrollEvent(400)));
    expect(seen.at(-1)).toBe(true);

    screen.rerender(createElement(Screen, { listMounted: false }));
    expect(seen.at(-1)).toBe(false);
  });

  it('does nothing without a store', () => {
    expect(() => render(createElement(ScrollEdgeListReset, { edge: undefined })).unmount()).not.toThrow();
  });
});
