// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { publishWindowInsetBottom, resetWindowInsetForTests } from '../../lib/window-inset-store';

const ctrl = vi.hoisted(() => ({
  insetsBottom: 139,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: ctrl.insetsBottom, left: 0, right: 0 }),
}));

import { useWindowBottomInset, WindowInsetPublisher } from '../use-window-bottom-inset';

describe('useWindowBottomInset', () => {
  beforeEach(() => {
    resetWindowInsetForTests();
    ctrl.insetsBottom = 139;
  });
  afterEach(() => {
    resetWindowInsetForTests();
  });

  it('returns the published window inset, not the mount point’s local inset', () => {
    // The bug this hook exists for: a sheet mounted inside a tab sees a local
    // inset of 139 (iOS 26 tab bar + accessory folded in by the per-tab
    // provider), but the sheet docks over that chrome — it must clear only the
    // window's 34pt home indicator.
    const { result } = renderHook(() => useWindowBottomInset());
    act(() => publishWindowInsetBottom(34));
    expect(result.current).toBe(34);
  });

  it('falls back to the local inset before the first publish', () => {
    // Pre-publish frames (no sheet can be open yet) and every existing test
    // that mocks react-native-safe-area-context keep the local meaning.
    const { result } = renderHook(() => useWindowBottomInset());
    expect(result.current).toBe(139);
  });

  it('tracks a later publish (rotation, bar change)', () => {
    const { result } = renderHook(() => useWindowBottomInset());
    act(() => publishWindowInsetBottom(34));
    act(() => publishWindowInsetBottom(21));
    expect(result.current).toBe(21);
  });

  it('WindowInsetPublisher publishes its own provider’s bottom inset and renders nothing', () => {
    // Mounted at the root layout its provider IS the window; here the mock
    // stands in for it.
    ctrl.insetsBottom = 34;
    const { container } = render(<WindowInsetPublisher />);
    expect(container.innerHTML).toBe('');
    const { result } = renderHook(() => useWindowBottomInset());
    // Consumers with a DIFFERENT local inset (tab-mounted sheet) now get the
    // published window value.
    ctrl.insetsBottom = 139;
    expect(result.current).toBe(34);
  });
});
