// @vitest-environment jsdom
// Android counterpart to sheet-presentation-provider.test.tsx: the ceiling __DEV__
// warning must NOT fire on Android, where there is no native onDismiss to beat the
// timer (Compose has no post-animation event, so the ceiling is the intended path).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';

// Pin Platform.OS to Android so SETTLE_MS = 350 and dismiss inFlight expectNative=false.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { SheetPresentationProvider, useSheetPresentation, type SheetCoordinator } from '../sheet-presentation-provider';

const SETTLE_MS = 350;

let coordinator: SheetCoordinator;
function Capture() {
  coordinator = useSheetPresentation();
  return null;
}

function makeSheet() {
  return { present: vi.fn(), dismiss: vi.fn(), onFullyDismissed: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  render(createElement(SheetPresentationProvider, null, createElement(Capture)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SheetPresentationProvider coordinator (Android)', () => {
  it('resolves requested presentation waiters at the existing Android ceiling without dismissing', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    const result = coordinator.waitForPresentation('a');
    const settled = vi.fn();
    void result.then(settled);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(result).resolves.toEqual({ status: 'presented' });
    expect(a.dismiss).not.toHaveBeenCalled();
  });

  it('does not warn (dev) when a coordinator-driven dismiss settles via the ceiling timer', () => {
    vi.stubGlobal('__DEV__', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    coordinator.setDesiredOpen('a', false);
    vi.advanceTimersByTime(SETTLE_MS); // ceiling settles — the only settle path on Android
    expect(a.onFullyDismissed).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
