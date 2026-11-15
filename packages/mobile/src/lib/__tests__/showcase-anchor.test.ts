// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LayoutChangeEvent } from 'react-native';
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', { 'data-testid': 'anchor-view' }, children),
}));
import {
  LayoutObserverProvider,
  ShowcaseAnchorView,
  useShowcaseAnchor,
  SHOWCASE_ANCHOR_NAMES,
  SHOWCASE_ANCHOR_LOG_PREFIX,
  formatShowcaseAnchorLine,
  type LayoutObservation,
} from '../showcase-anchor';
import { reportLayoutObservation } from '../../dev/integration/layout-reporting';
const layout = {} as LayoutChangeEvent;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('layout observer and showcase contract', () => {
  it('preserves recorder names and exact numeric log protocol', () => {
    const contract = readFileSync(
      resolve(import.meta.dirname, '../../../../../scripts/lib/showcase-video/contract.ts'),
      'utf8',
    );
    const names = contract.match(/export const SHOWCASE_ANCHOR_NAMES = \[([^\]]*)\] as const;/)?.[1] ?? '';
    expect([...names.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual([...SHOWCASE_ANCHOR_NAMES]);
    expect(contract).toContain(`export const SHOWCASE_ANCHOR_LOG_PREFIX = '${SHOWCASE_ANCHOR_LOG_PREFIX}'`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportLayoutObservation({ name: 'board-surface', x: 24, y: 118.333, width: 132, height: 32 });
    expect(log).toHaveBeenCalledWith(
      '[showcase-anchor] {"name":"board-surface","x":24,"y":118.3,"width":132,"height":32}',
    );
    expect(formatShowcaseAnchorLine('board-surface', 0, 0, 0, 1)).toBeNull();
  });
  it('returns the same inert props and adds no wrapper without an observer', () => {
    const { result } = renderHook(() => [useShowcaseAnchor('board-surface'), useShowcaseAnchor('invite-qr')]);
    expect(result.current[0]).toBe(result.current[1]);
    expect(result.current[0]).toEqual({ ref: undefined, onLayout: undefined });
    const { queryByTestId, getByText } = render(
      createElement(ShowcaseAnchorView, { name: 'play-next', children: 'Child' }),
    );
    expect(queryByTestId('anchor-view')).toBeNull();
    expect(getByText('Child')).toBeTruthy();
  });
  it('reports initial and settled geometry, suppresses duplicates and cancels on unmount', () => {
    vi.useFakeTimers();
    const observe = vi.fn<(rect: LayoutObservation) => void>();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(LayoutObserverProvider, { onLayoutObserved: observe, children });
    const { result, unmount } = renderHook(() => useShowcaseAnchor('invite-qr'), { wrapper });
    let top = 900;
    const measureInWindow = vi.fn((done: (x: number, y: number, width: number, height: number) => void) =>
      done(100, top, 200, 200),
    );
    result.current.ref?.({ measureInWindow });
    result.current.onLayout?.(layout);
    top = 420;
    vi.advanceTimersByTime(250);
    expect(observe.mock.calls.map(([rect]) => rect.y)).toEqual([900, 420]);
    vi.advanceTimersByTime(450);
    expect(observe).toHaveBeenCalledTimes(2);
    result.current.onLayout?.(layout);
    unmount();
    const before = measureInWindow.mock.calls.length;
    vi.runAllTimers();
    expect(measureInWindow).toHaveBeenCalledTimes(before);
  });
});
