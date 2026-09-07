import { describe, it, expect, vi } from 'vitest';

// Mock the haptics module so importing Button.logic never pulls in react-native
// (its only transitive dependency, via lib/haptics) under the node test env. The
// tests inject their own haptic fn, so this just keeps the default import safe.
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }));

import {
  buttonFillAxes,
  buttonMatchContents,
  isFullWidthStyle,
  makeButtonPressHandler,
  pinnedButtonHeight,
} from '../Button.logic';

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

describe('isFullWidthStyle', () => {
  it('is false for no style (inline, content-hugging)', () => {
    expect(isFullWidthStyle(undefined)).toBe(false);
  });

  // The regression this guards: `flex: 0` means "don't grow", so it must NOT
  // stretch the button — the old `style.flex != null` check wrongly caught 0.
  it('is false for flex: 0', () => {
    expect(isFullWidthStyle({ flex: 0 })).toBe(false);
  });

  it('is true for a positive flex (fills the flex row)', () => {
    expect(isFullWidthStyle({ flex: 1 })).toBe(true);
  });

  it("is true for width: '100%'", () => {
    expect(isFullWidthStyle({ width: '100%' })).toBe(true);
  });

  it("is true for alignSelf: 'stretch'", () => {
    expect(isFullWidthStyle({ alignSelf: 'stretch' })).toBe(true);
  });

  it('is false for a fixed pixel width or a non-stretch alignSelf', () => {
    expect(isFullWidthStyle({ width: 120 })).toBe(false);
    expect(isFullWidthStyle({ alignSelf: 'flex-start' })).toBe(false);
  });
});

describe('pinnedButtonHeight', () => {
  it('is undefined when the caller left the height to the native control', () => {
    expect(pinnedButtonHeight(undefined)).toBeUndefined();
    expect(pinnedButtonHeight({ flex: 1 })).toBeUndefined();
  });

  it('reads a numeric height', () => {
    expect(pinnedButtonHeight({ flex: 1, height: 56 })).toBe(56);
  });

  // Neither can be handed to a native fixed-height modifier, so neither counts.
  it("ignores a percentage or 'auto' height", () => {
    expect(pinnedButtonHeight({ height: '100%' })).toBeUndefined();
    expect(pinnedButtonHeight({ height: 'auto' })).toBeUndefined();
  });
});

describe('buttonFillAxes', () => {
  it('fills neither axis for an inline button', () => {
    expect(buttonFillAxes(undefined)).toEqual({ width: false, height: false });
  });

  it('fills width only for a flexed button with no pinned height', () => {
    expect(buttonFillAxes({ flex: 1 })).toEqual({ width: true, height: false });
  });

  it('fills both axes for a flexed button with a pinned height', () => {
    expect(buttonFillAxes({ flex: 2, height: 56 })).toEqual({ width: true, height: true });
  });

  it('fills height only for an inline button with a pinned height', () => {
    expect(buttonFillAxes({ height: 56 })).toEqual({ width: false, height: true });
  });
});

describe('buttonMatchContents', () => {
  // The regression this guards: Host writes the measured native size back over
  // the RN style (`setStyleSize`) for every axis it matches, so an axis the
  // caller sized must not be matched — that is why a `height` on a Button's
  // style silently did nothing.
  it('measures both axes for an inline button', () => {
    expect(buttonMatchContents(undefined)).toEqual({ horizontal: true, vertical: true });
  });

  it('leaves the width to Yoga when the button is flexed', () => {
    expect(buttonMatchContents({ flex: 1 })).toEqual({ horizontal: false, vertical: true });
  });

  it('leaves the height to Yoga when the caller pinned one', () => {
    expect(buttonMatchContents({ flex: 1, height: 56 })).toEqual({ horizontal: false, vertical: false });
    expect(buttonMatchContents({ height: 56 })).toEqual({ horizontal: true, vertical: false });
  });
});
