import { describe, it, expect, vi } from 'vitest';

// Mock the haptics module so importing Button.logic never pulls in react-native
// (its only transitive dependency, via lib/haptics) under the node test env. The
// tests inject their own haptic fn, so this just keeps the default import safe.
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }));

import { makeButtonPressHandler } from '../Button.logic';

// The Button is a native @expo/ui control split across Button.ios.tsx /
// Button.android.tsx, which can't mount under vitest. The press/haptic guard that
// used to live inside the component now lives in Button.logic.ts so it stays
// node-testable here without a native tree (mirrors switch-row.logic).

describe('makeButtonPressHandler', () => {
  it('fires the haptic then onPress when enabled', () => {
    const onPress = vi.fn();
    const haptic = vi.fn();
    makeButtonPressHandler({ onPress }, haptic)();
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when disabled (no haptic, no onPress)', () => {
    const onPress = vi.fn();
    const haptic = vi.fn();
    makeButtonPressHandler({ onPress, disabled: true }, haptic)();
    expect(haptic).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('is a no-op while loading (a tap during an in-flight action does nothing)', () => {
    const onPress = vi.fn();
    const haptic = vi.fn();
    makeButtonPressHandler({ onPress, loading: true }, haptic)();
    expect(haptic).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('skips the haptic when haptic is false but still calls onPress', () => {
    const onPress = vi.fn();
    const haptic = vi.fn();
    makeButtonPressHandler({ onPress, haptic: false }, haptic)();
    expect(haptic).not.toHaveBeenCalled();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
