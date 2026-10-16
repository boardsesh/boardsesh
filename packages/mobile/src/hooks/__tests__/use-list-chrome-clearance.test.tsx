// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useListChromeClearance } from '../use-list-chrome-clearance';

function renderClearance(topOffset = -100) {
  const scrollToOffset = vi.fn();
  const listRef = { current: { scrollToOffset } };
  const forwardedScroll = vi.fn();
  let renders = 0;
  const view = renderHook(() => {
    renders += 1;
    return useListChromeClearance({ initialHeight: 100, topOffset, listRef, onScroll: forwardedScroll });
  });
  const measure = (height: number) => act(() => view.result.current.onChromeHeightChange(height));
  const scroll = (offset: number) =>
    act(() =>
      view.result.current.onScroll({
        nativeEvent: { contentOffset: { x: 0, y: offset } },
      } as NativeSyntheticEvent<NativeScrollEvent>),
    );
  const commitLayout = () => act(() => view.result.current.onCommitLayoutEffect());
  return { ...view, listRef, scrollToOffset, forwardedScroll, measure, scroll, commitLayout, renders: () => renders };
}

describe('useListChromeClearance', () => {
  it('measures initial chrome and an initially open rail without scrolling', () => {
    const { result, measure, commitLayout, scrollToOffset } = renderClearance();
    measure(0);
    measure(104);
    commitLayout();
    expect(result.current.chromeHeight).toBe(104);
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it.each([-100, 0])('lets results move below open controls at resting offset %s', (topOffset) => {
    const { result, measure, scroll, commitLayout, scrollToOffset } = renderClearance(topOffset);
    measure(44);
    scroll(topOffset);
    measure(104);
    commitLayout();
    expect(result.current.chromeHeight).toBe(104);
    measure(44);
    commitLayout();
    expect(result.current.chromeHeight).toBe(44);
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it.each([-100, 0])('preserves a scrolled row when controls open and close (rest %s)', (topOffset) => {
    const { measure, scroll, commitLayout, scrollToOffset } = renderClearance(topOffset);
    measure(44);
    scroll(500);
    measure(104);
    expect(scrollToOffset).not.toHaveBeenCalled();
    commitLayout();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 560, animated: false });
    scroll(560);
    measure(44);
    commitLayout();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 500, animated: false });
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it('does not apply a height compensation twice across list layout commits', () => {
    const { measure, scroll, commitLayout, scrollToOffset } = renderClearance();
    measure(44);
    scroll(500);
    measure(104);
    commitLayout();
    commitLayout();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 560, animated: false });
  });

  it('accumulates height reports before the list commits', () => {
    const { measure, scroll, commitLayout, scrollToOffset } = renderClearance();
    measure(44);
    scroll(500);
    measure(104);
    measure(120);
    commitLayout();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 576, animated: false });
  });

  it('preserves scrolling that arrives between the height report and list commit', () => {
    const { measure, scroll, commitLayout, scrollToOffset } = renderClearance();
    measure(44);
    scroll(500);
    measure(104);
    scroll(520);
    commitLayout();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 580, animated: false });
  });

  it('lets the climber return to the top while a layout update is pending', () => {
    const { measure, scroll, commitLayout, scrollToOffset } = renderClearance();
    measure(44);
    scroll(500);
    measure(104);
    scroll(-100);
    commitLayout();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it.each([-100, 0])('clamps shrinking controls near the resting top %s', (topOffset) => {
    const { measure, scroll, commitLayout, scrollToOffset } = renderClearance(topOffset);
    measure(104);
    scroll(topOffset + 20);
    measure(44);
    commitLayout();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: topOffset, animated: false });
  });

  it('leaves a pull-to-refresh and resting subpoint offsets alone', () => {
    const { measure, scroll, commitLayout, scrollToOffset } = renderClearance();
    measure(44);
    scroll(-150);
    measure(104);
    commitLayout();
    scroll(-99.5);
    measure(44);
    commitLayout();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('gives a new-search reset priority over pending and late height reports', () => {
    const { result, measure, scroll, commitLayout, scrollToOffset } = renderClearance();
    measure(44);
    scroll(500);
    measure(104);
    act(() => result.current.resetScrollToTop());
    commitLayout();
    measure(120);
    commitLayout();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: -100, animated: false });
  });

  it('does not send an old list correction to its replacement', () => {
    const { listRef, measure, scroll, commitLayout, scrollToOffset } = renderClearance();
    measure(44);
    scroll(500);
    measure(104);
    const replacementScroll = vi.fn();
    listRef.current = { scrollToOffset: replacementScroll };
    commitLayout();
    measure(120);
    commitLayout();
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(replacementScroll).not.toHaveBeenCalled();
  });

  it('forwards native scroll events without per-frame renders or callback changes', () => {
    const { result, measure, scroll, forwardedScroll, renders } = renderClearance();
    measure(44);
    const before = renders();
    const handler = result.current.onScroll;
    for (const offset of [-100, 0, 250, 500, -100]) scroll(offset);
    expect(renders()).toBe(before);
    expect(result.current.onScroll).toBe(handler);
    expect(forwardedScroll).toHaveBeenCalledTimes(5);
  });
});
