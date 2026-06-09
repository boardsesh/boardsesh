// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import {
  TabBarHeightProvider,
  useMeasuredTabBarHeight,
  useSetMeasuredTabBarHeight,
} from '../tab-bar-height-provider';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(TabBarHeightProvider, null, children);
}

function useBoth() {
  return { height: useMeasuredTabBarHeight(), setHeight: useSetMeasuredTabBarHeight() };
}

describe('TabBarHeightProvider', () => {
  it('starts null and exposes the latest published height', () => {
    const { result } = renderHook(useBoth, { wrapper });
    expect(result.current.height).toBeNull();
    act(() => result.current.setHeight(80));
    expect(result.current.height).toBe(80);
  });

  it('ignores sub-0.5px churn but commits meaningful changes', () => {
    const { result } = renderHook(useBoth, { wrapper });
    act(() => result.current.setHeight(80));
    expect(result.current.height).toBe(80);
    act(() => result.current.setHeight(80.3)); // < 0.5px drift → ignored (no render loop)
    expect(result.current.height).toBe(80);
    act(() => result.current.setHeight(80.6)); // >= 0.5px → committed
    expect(result.current.height).toBe(80.6);
  });

  it('degrades to null / no-op without a provider', () => {
    const { result } = renderHook(useBoth);
    expect(result.current.height).toBeNull();
    expect(() => act(() => result.current.setHeight(50))).not.toThrow();
    expect(result.current.height).toBeNull();
  });
});
