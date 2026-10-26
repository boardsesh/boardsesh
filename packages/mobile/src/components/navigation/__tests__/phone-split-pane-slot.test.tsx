// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import {
  PhoneSplitPaneSlotContext,
  resetPhoneSplitPaneTakenForTests,
  useHasPhoneSplitPaneSlot,
  usePhoneSplitPaneContent,
  usePhoneSplitPaneTaken,
} from '../phone-split-pane-slot';

function Screen({ content }: { content: ReactNode | null }) {
  usePhoneSplitPaneContent(content);
  return null;
}

describe('phone-split-pane-slot', () => {
  afterEach(() => {
    resetPhoneSplitPaneTakenForTests();
  });

  it('hands content to the host, marks the pane taken, and gives it back on unmount', () => {
    const setPaneContent = vi.fn();
    const taken = renderHook(() => usePhoneSplitPaneTaken());
    const preview = createElement('div', null, 'preview');
    const view = render(
      createElement(
        PhoneSplitPaneSlotContext.Provider,
        { value: setPaneContent },
        createElement(Screen, { content: preview }),
      ),
    );
    expect(setPaneContent).toHaveBeenLastCalledWith(preview);
    taken.rerender();
    expect(taken.result.current).toBe(true);

    view.unmount();
    expect(setPaneContent).toHaveBeenLastCalledWith(null);
    taken.rerender();
    expect(taken.result.current).toBe(false);
  });

  it('hands the pane back when the screen drops its content', () => {
    const setPaneContent = vi.fn();
    const taken = renderHook(() => usePhoneSplitPaneTaken());
    const view = render(
      createElement(
        PhoneSplitPaneSlotContext.Provider,
        { value: setPaneContent },
        createElement(Screen, { content: createElement('div') }),
      ),
    );
    view.rerender(
      createElement(
        PhoneSplitPaneSlotContext.Provider,
        { value: setPaneContent },
        createElement(Screen, { content: null }),
      ),
    );
    expect(setPaneContent).toHaveBeenLastCalledWith(null);
    taken.rerender();
    expect(taken.result.current).toBe(false);
  });

  it('is a no-op outside a tab host with a split pane', () => {
    const taken = renderHook(() => usePhoneSplitPaneTaken());
    render(createElement(Screen, { content: createElement('div') }));
    taken.rerender();
    expect(taken.result.current).toBe(false);
    expect(renderHook(() => useHasPhoneSplitPaneSlot()).result.current).toBe(false);
  });
});
