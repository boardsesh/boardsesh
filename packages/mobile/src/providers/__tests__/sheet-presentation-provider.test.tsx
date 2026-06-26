// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

// SETTLE_MS resolves from Platform.OS — pin it to iOS (550ms) for deterministic timers.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { SheetPresentationProvider, useSheetPresentation, type SheetCoordinator } from '../sheet-presentation-provider';

const SETTLE_MS = 550;

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
  vi.stubGlobal('__DEV__', false);
  render(createElement(SheetPresentationProvider, null, createElement(Capture)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SheetPresentationProvider coordinator', () => {
  it('presents an opened sheet and reports it presented after the settle window', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });

    coordinator.setDesiredOpen('a', true);
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(coordinator.isBusy('root')).toBe(true);
    expect(coordinator.isPresented('a')).toBe(false); // still presenting

    vi.advanceTimersByTime(SETTLE_MS);
    expect(coordinator.isPresented('a')).toBe(true);
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('serializes a sheet-over-sheet handoff: dismiss A, settle, then present B', () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS); // a presented

    // Request B while A is up — must not present B yet.
    coordinator.setDesiredOpen('b', true);
    expect(b.present).not.toHaveBeenCalled();
    // The pump immediately dismisses A (the dismiss half of the handoff).
    expect(a.dismiss).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // A dismiss settles
    expect(b.present).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);

    vi.advanceTimersByTime(SETTLE_MS); // B present settles
    expect(coordinator.isPresented('b')).toBe(true);
  });

  it('never presents two transitions at once (B waits while A is presenting)', () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    coordinator.setDesiredOpen('b', true); // while A's present is still in flight
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(b.present).not.toHaveBeenCalled();
    expect(a.dismiss).not.toHaveBeenCalled(); // can't dismiss mid-present either
  });

  it('early-resolves a dismiss via notifyFullyDismissed before the ceiling timer', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    coordinator.setDesiredOpen('a', false);
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    expect(coordinator.isBusy('root')).toBe(true);

    coordinator.notifyFullyDismissed('a'); // native settle arrives early
    expect(a.onFullyDismissed).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);
    expect(coordinator.isBusy('root')).toBe(false);

    // The ceiling timer is cleared — advancing must not double-fire.
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.onFullyDismissed).toHaveBeenCalledTimes(1);
  });

  it('opens a settle window on a user-initiated close (notifyClosed) and fires onFullyDismissed at settle', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    // User pan-down: the native sheet is already animating out on its own.
    coordinator.notifyClosed('a');
    expect(a.dismiss).not.toHaveBeenCalled(); // coordinator didn't drive it
    expect(coordinator.isBusy('root')).toBe(true);
    expect(a.onFullyDismissed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.onFullyDismissed).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);
  });

  it('is a no-op to close a sheet that is not presented', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', false);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.present).not.toHaveBeenCalled();
    expect(a.dismiss).not.toHaveBeenCalled();
  });

  it('coalesces a rapid open→close→open into a single settled-open with no dismiss', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });

    coordinator.setDesiredOpen('a', true); // present starts
    coordinator.setDesiredOpen('a', false); // desired flips while presenting
    coordinator.setDesiredOpen('a', true); // ...and back

    vi.advanceTimersByTime(SETTLE_MS); // present settles; pump sees want === have
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(a.dismiss).not.toHaveBeenCalled();
    expect(coordinator.isPresented('a')).toBe(true);
  });

  it('does not serialize across independent presenter groups', () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'drawer', ...b });

    coordinator.setDesiredOpen('a', true);
    coordinator.setDesiredOpen('b', true);
    // Different groups → both present immediately, no waiting.
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(b.present).toHaveBeenCalledTimes(1);
  });

  it('unregister clears a presented sheet and frees the group', () => {
    const a = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(coordinator.isPresented('a')).toBe(true);

    unregister();
    expect(coordinator.isPresented('a')).toBe(false);
    expect(coordinator.isBusy('root')).toBe(false);
  });
});
