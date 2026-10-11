// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

// The list's resting top: minus the UIKit header's height, or 0 everywhere else.
const header = vi.hoisted(() => ({ listTopOffset: -106 }));
vi.mock('../use-list-top-offset', () => ({ useListTopOffset: () => header.listTopOffset }));

import { SCROLL_EDGE_SLACK, useScrollEdgeBackdrop } from '../use-scroll-edge-backdrop';

function scrollEvent(offsetY: number): NativeSyntheticEvent<NativeScrollEvent> {
  return { nativeEvent: { contentOffset: { x: 0, y: offsetY } } } as NativeSyntheticEvent<NativeScrollEvent>;
}

/** Renders the hook and counts renders, so a per-event state update shows up. */
function renderBackdrop(initialListKey?: string) {
  let renders = 0;
  const hook = renderHook(
    ({ listKey }: { listKey?: string }) => {
      renders += 1;
      return useScrollEdgeBackdrop(listKey);
    },
    { initialProps: { listKey: initialListKey } },
  );
  const scrollTo = (offsetY: number) => act(() => hook.result.current.onScroll(scrollEvent(offsetY)));
  return { ...hook, scrollTo, renders: () => renders, scrolledUnder: () => hook.result.current.scrolledUnder };
}

describe('useScrollEdgeBackdrop', () => {
  beforeEach(() => {
    header.listTopOffset = -106;
  });

  it('starts at rest, before the list has scrolled at all', () => {
    expect(renderBackdrop().scrolledUnder()).toBe(false);
  });

  it('flips once when the list passes its resting top, and once when it comes back', () => {
    const list = renderBackdrop();
    const rendersAtRest = list.renders();

    // A whole fling of scroll events, every one of them past the top.
    for (const offset of [-100, -60, 0, 240, 900, 2400]) list.scrollTo(offset);
    expect(list.scrolledUnder()).toBe(true);
    expect(list.renders()).toBe(rendersAtRest + 1);

    for (const offset of [900, 240, -50, -106]) list.scrollTo(offset);
    expect(list.scrolledUnder()).toBe(false);
    expect(list.renders()).toBe(rendersAtRest + 2);
  });

  it('never re-renders for scroll events that leave the answer unchanged', () => {
    const list = renderBackdrop();
    const rendersAtRest = list.renders();

    for (const offset of [-106, -106.4, -105, -104.5]) list.scrollTo(offset);

    expect(list.scrolledUnder()).toBe(false);
    expect(list.renders()).toBe(rendersAtRest);
  });

  it('keeps a couple of points of slack at the resting top', () => {
    const list = renderBackdrop();

    list.scrollTo(-106 + SCROLL_EDGE_SLACK);
    expect(list.scrolledUnder()).toBe(false);

    list.scrollTo(-106 + SCROLL_EDGE_SLACK + 0.5);
    expect(list.scrolledUnder()).toBe(true);
  });

  // Overscroll and pull-to-refresh both move the offset further negative.
  it('treats the rubber-band overscroll and a pull-to-refresh as at rest', () => {
    const list = renderBackdrop();
    const rendersAtRest = list.renders();

    for (const offset of [-120, -180, -240, -166, -166, -130, -106]) list.scrollTo(offset);

    expect(list.scrolledUnder()).toBe(false);
    expect(list.renders()).toBe(rendersAtRest);
  });

  it('turns the blur off when a scrolled list is flung back past its top', () => {
    const list = renderBackdrop();
    list.scrollTo(300);
    expect(list.scrolledUnder()).toBe(true);

    // The bounce at the top overshoots before it settles.
    for (const offset of [-140, -118, -106]) list.scrollTo(offset);
    expect(list.scrolledUnder()).toBe(false);
  });

  // Android, Material, the web and the old floating chrome: no UIKit inset.
  it('works from a resting top of 0 where there is no UIKit header', () => {
    header.listTopOffset = 0;
    const list = renderBackdrop();

    for (const offset of [0, 1, SCROLL_EDGE_SLACK, -40]) list.scrollTo(offset);
    expect(list.scrolledUnder()).toBe(false);

    list.scrollTo(SCROLL_EDGE_SLACK + 1);
    expect(list.scrolledUnder()).toBe(true);
  });

  describe('under a collapsing large title', () => {
    // JS first hears the compact height (106), then the expanded bar (158).
    const mountUnderLargeTitle = () => {
      const list = renderBackdrop();
      header.listTopOffset = -158;
      list.rerender({ listKey: undefined });
      return list;
    };

    it('is at rest under the expanded title', () => {
      const list = mountUnderLargeTitle();
      list.scrollTo(-158);
      expect(list.scrolledUnder()).toBe(false);
    });

    // The controls move up with the title, so no row is under them yet. JS hears
    // the bar's height late, and comparing against the height of the moment
    // would flicker the blur through this whole stretch.
    it('stays off while the title collapses, whatever height JS last heard', () => {
      const list = mountUnderLargeTitle();
      const rendersAtRest = list.renders();

      for (const offset of [-150, -140, -128, -110, -106]) list.scrollTo(offset);

      expect(list.scrolledUnder()).toBe(false);
      expect(list.renders()).toBe(rendersAtRest);
    });

    it('turns on once the list passes the top under the collapsed bar', () => {
      const list = mountUnderLargeTitle();
      list.scrollTo(-100);
      expect(list.scrolledUnder()).toBe(true);
    });

    // A held pull stretches the bar; JS can still hold that taller height for a
    // moment after the list has snapped back.
    it('does not flash on when a pull-to-refresh has stretched the bar', () => {
      const list = mountUnderLargeTitle();
      list.scrollTo(-218);
      header.listTopOffset = -218;
      list.rerender({ listKey: undefined });
      const rendersPulled = list.renders();

      for (const offset of [-200, -180, -158]) list.scrollTo(offset);

      expect(list.scrolledUnder()).toBe(false);
      expect(list.renders()).toBe(rendersPulled);
    });

    it('follows the bar to a shorter height with no scroll event to prompt it', () => {
      // A screen that has only ever seen the expanded bar...
      header.listTopOffset = -158;
      const list = renderBackdrop();
      list.scrollTo(-106);
      expect(list.scrolledUnder()).toBe(true);

      // ...learns the collapsed height when the bar settles there. The list has
      // not moved, and it is exactly at that top.
      header.listTopOffset = -106;
      list.rerender({ listKey: undefined });
      expect(list.scrolledUnder()).toBe(false);
    });
  });

  describe('when the screen swaps the list under the same chrome', () => {
    it('reads the new list as at rest in the render that mounts it', () => {
      const seen: boolean[] = [];
      const hook = renderHook(
        ({ listKey }: { listKey: string }) => {
          const backdrop = useScrollEdgeBackdrop(listKey);
          seen.push(backdrop.scrolledUnder);
          return backdrop;
        },
        { initialProps: { listKey: 'progress' } },
      );
      act(() => hook.result.current.onScroll(scrollEvent(400)));
      expect(hook.result.current.scrolledUnder).toBe(true);

      seen.length = 0;
      hook.rerender({ listKey: 'sessions' });

      // No committed render shows the old list's blur over the new list.
      expect(hook.result.current.scrolledUnder).toBe(false);
      expect(seen.at(-1)).toBe(false);
    });

    it('tracks the new list from its own first scroll', () => {
      const list = renderBackdrop('progress');
      list.scrollTo(400);
      list.rerender({ listKey: 'sessions' });

      list.scrollTo(-106);
      expect(list.scrolledUnder()).toBe(false);
      list.scrollTo(40);
      expect(list.scrolledUnder()).toBe(true);
    });

    it('does not bring back a stale answer when the first list returns', () => {
      const list = renderBackdrop('progress');
      list.scrollTo(400);
      list.rerender({ listKey: 'sessions' });
      list.rerender({ listKey: 'progress' });

      expect(list.scrolledUnder()).toBe(false);
    });
  });
});
