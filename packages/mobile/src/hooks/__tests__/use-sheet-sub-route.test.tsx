// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

// The focus effect the hook registered, so a test can fire a focus by hand
// (the screen regaining focus when the pushed route pops).
const navigation = vi.hoisted(() => ({ focusEffect: undefined as (() => void) | undefined }));
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => {
    navigation.focusEffect = effect;
  },
}));

import { useSheetSubRoute } from '../use-sheet-sub-route';

type ScrollHandle = { scrollTo: (options: { y: number; animated: boolean }) => void };

const focusScreen = () => act(() => navigation.focusEffect?.());

function scrollEvent(offsetY: number): NativeSyntheticEvent<NativeScrollEvent> {
  return { nativeEvent: { contentOffset: { x: 0, y: offsetY } } } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
}

function renderSubRoute(canResume: () => boolean = () => true) {
  const scrollTo = vi.fn();
  const view = renderHook(({ resume }) => useSheetSubRoute<ScrollHandle>({ canResume: resume }), {
    initialProps: { resume: canResume },
  });
  view.result.current.scrollRef.current = { scrollTo };
  return { ...view, scrollTo };
}

describe('useSheetSubRoute', () => {
  beforeEach(() => {
    navigation.focusEffect = undefined;
  });

  it('starts presented, and the first focus is not a return', () => {
    const { result } = renderSubRoute();
    expect(result.current.suspended).toBe(false);
    expect(result.current.presentEpoch).toBe(0);
    expect(result.current.isAwaitingReturn()).toBe(false);

    focusScreen();

    expect(result.current.suspended).toBe(false);
    expect(result.current.presentEpoch).toBe(0);
  });

  it('suspends for the pushed route and re-presents under a new key when it pops', () => {
    const { result } = renderSubRoute();

    act(() => result.current.suspend());
    expect(result.current.suspended).toBe(true);
    expect(result.current.isAwaitingReturn()).toBe(true);

    focusScreen();

    expect(result.current.suspended).toBe(false);
    expect(result.current.isAwaitingReturn()).toBe(false);
    expect(result.current.presentEpoch).toBe(1);
  });

  it('counts each round trip as a new presentation', () => {
    const { result } = renderSubRoute();
    for (let trip = 1; trip <= 3; trip += 1) {
      act(() => result.current.suspend());
      focusScreen();
      expect(result.current.presentEpoch).toBe(trip);
    }
  });

  it('stays closed when the presentation is stale by the time focus returns', () => {
    let current = true;
    const { result } = renderSubRoute(() => current);
    act(() => result.current.suspend());

    current = false;
    focusScreen();

    expect(result.current.suspended).toBe(true);
    expect(result.current.presentEpoch).toBe(0);
  });

  it('reads the latest canResume, not the one from the first render', () => {
    const { result, rerender } = renderSubRoute(() => false);
    act(() => result.current.suspend());

    rerender({ resume: () => true });
    focusScreen();

    expect(result.current.suspended).toBe(false);
    expect(result.current.presentEpoch).toBe(1);
  });

  it('does not re-present after the route finished the job itself', () => {
    const { result } = renderSubRoute();
    act(() => result.current.suspend());

    act(() => result.current.cancelResume());
    focusScreen();

    expect(result.current.isAwaitingReturn()).toBe(false);
    expect(result.current.presentEpoch).toBe(0);
  });

  it('restores the offset it had when it suspended, once per return', () => {
    const { result, scrollTo } = renderSubRoute();
    act(() => result.current.onScroll(scrollEvent(320)));
    act(() => result.current.suspend());
    // The remounted body reports y=0 before its content has laid out.
    act(() => result.current.onScroll(scrollEvent(0)));

    focusScreen();
    result.current.scrollRef.current = { scrollTo };
    act(() => result.current.onContentSizeChange());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 320, animated: false });

    // Later content growth (a section appearing) must not yank the scroll.
    act(() => result.current.onContentSizeChange());
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('does not scroll on the first mount', () => {
    const { result, scrollTo } = renderSubRoute();
    act(() => result.current.onScroll(scrollEvent(120)));
    act(() => result.current.onContentSizeChange());
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps its callbacks and focus effect stable across renders', () => {
    const { result, rerender } = renderSubRoute();
    const first = result.current;
    const firstFocusEffect = navigation.focusEffect;

    rerender({ resume: () => true });

    expect(navigation.focusEffect).toBe(firstFocusEffect);
    expect(result.current.suspend).toBe(first.suspend);
    expect(result.current.cancelResume).toBe(first.cancelResume);
    expect(result.current.isAwaitingReturn).toBe(first.isAwaitingReturn);
    expect(result.current.onScroll).toBe(first.onScroll);
    expect(result.current.scrollRef).toBe(first.scrollRef);
  });
});
