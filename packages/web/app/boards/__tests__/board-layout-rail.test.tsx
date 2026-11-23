import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import BoardLayoutRail from '../board-layout-rail';

let measureRail: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        measureRail = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderRail() {
  render(
    <>
      <h2 id="layouts">Tension</h2>
      <BoardLayoutRail labelledBy="layouts" previousLabel="Previous layouts" nextLabel="Next layouts">
        <li>
          <a href="/first">First layout</a>
        </li>
        <li>Second layout</li>
        <li>Third layout</li>
      </BoardLayoutRail>
    </>,
  );
  const rail = screen.getByRole('list', { name: 'Tension' });
  Object.defineProperties(rail, {
    clientWidth: { configurable: true, value: 324 },
    scrollWidth: { configurable: true, value: 647 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  const firstCard = rail.firstElementChild;
  if (!firstCard) throw new Error('Missing rail card');
  vi.spyOn(firstCard, 'getBoundingClientRect').mockReturnValue({ width: 205 } as DOMRect);
  const scrollBy = vi.fn();
  const scrollTo = vi.fn();
  rail.scrollBy = scrollBy;
  rail.scrollTo = scrollTo;
  act(() => measureRail());
  return { rail, scrollBy, scrollTo };
}

describe('board layout rail', () => {
  it('exposes controls only while overflowing and disables each settled edge', () => {
    const { rail } = renderRail();
    expect(screen.getByRole('button', { name: 'Previous layouts' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Next layouts' }).hasAttribute('disabled')).toBe(false);
    rail.scrollLeft = 323;
    fireEvent.scroll(rail);
    expect(screen.getByRole('button', { name: 'Previous layouts' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Next layouts' }).hasAttribute('disabled')).toBe(true);
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 647 });
    act(() => measureRail());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves a fitting list outside tab order and preserves native key defaults', () => {
    const { rail, scrollBy, scrollTo } = renderRail();
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 647 });
    act(() => measureRail());
    expect(rail.hasAttribute('tabindex')).toBe(false);
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(fireEvent.keyDown(rail, { key, cancelable: true })).toBe(true);
    }
    expect(scrollBy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('supports buttons and Arrow/Home/End without intercepting nested links', () => {
    const { rail, scrollBy, scrollTo } = renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Next layouts' }));
    expect(scrollBy.mock.calls[0]?.[0].left).toBeGreaterThan(0);
    fireEvent.keyDown(rail, { key: 'ArrowLeft' });
    expect(scrollBy.mock.calls[1]?.[0].left).toBeLessThan(0);
    fireEvent.keyDown(rail, { key: 'Home' });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0 });
    fireEvent.keyDown(rail, { key: 'End' });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 647 });
    fireEvent.keyDown(screen.getByRole('link'), { key: 'ArrowRight' });
    expect(scrollBy).toHaveBeenCalledTimes(2);
    expect(rail.tabIndex).toBe(0);
  });
});
