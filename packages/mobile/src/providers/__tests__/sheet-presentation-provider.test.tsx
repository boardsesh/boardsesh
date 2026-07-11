// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, useRef, type RefObject } from 'react';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';

// SETTLE_MS resolves from Platform.OS — pin it to iOS (550ms) for deterministic timers.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import {
  SheetPresentationProvider,
  useSheetPresentation,
  useManagedSheet,
  type SheetCoordinator,
} from '../sheet-presentation-provider';

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

  it('warns (dev) when an iOS coordinator-driven dismiss settles via the ceiling timer', () => {
    vi.stubGlobal('__DEV__', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    coordinator.setDesiredOpen('a', false); // coordinator drives the dismiss (expectNative on iOS)
    vi.advanceTimersByTime(SETTLE_MS); // no native onDismiss arrived → ceiling wins
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('outran the ceiling');
    warn.mockRestore();
  });

  it('does not warn when an unmounted-while-presented sheet settles via the ceiling (no native signal expected)', () => {
    vi.stubGlobal('__DEV__', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    unregister(); // registration gone → notifyFullyDismissed can never match; ceiling is the only settle
    vi.advanceTimersByTime(SETTLE_MS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  it('warns (dev) when an iOS user-initiated close (notifyClosed) settles via the ceiling timer', () => {
    vi.stubGlobal('__DEV__', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    coordinator.notifyClosed('a'); // pan-down opens a settle window (expectNative on iOS)
    vi.advanceTimersByTime(SETTLE_MS); // native onDismiss never arrived → ceiling wins
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('outran the ceiling');
    warn.mockRestore();
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

  it('opens a settle window when a presented sheet unmounts (no coordinator dismiss), then frees the group', () => {
    const a = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(coordinator.isPresented('a')).toBe(true);

    // Parent unmounts the sheet while it's presented (e.g. a present-on-mount
    // sheet dismissed by removing it). Its native teardown is still animating, so
    // the group must stay busy — not be reported idle immediately (H1).
    unregister();
    expect(coordinator.isPresented('a')).toBe(false);
    expect(coordinator.isBusy('root')).toBe(true);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('holds a same-group present until an unmounted-while-presented sheet has settled (H1)', () => {
    const a = makeSheet();
    const b = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    unregister(); // A unmounts while presented → settle window opens
    coordinator.setDesiredOpen('b', true);
    expect(b.present).not.toHaveBeenCalled(); // must wait out A's native teardown

    vi.advanceTimersByTime(SETTLE_MS);
    expect(b.present).toHaveBeenCalledTimes(1);
  });

  // The phantom-sheet bug: a sheet displaced by a handoff used to keep its
  // desired-open flag, so it re-presented "at random" when the displacing sheet
  // closed (tick sheet reopening after the BLE device picker went away).
  it('closes a displaced sheet: onDisplaced fires and it never re-presents after the displacer closes', async () => {
    const a = { ...makeSheet(), onDisplaced: vi.fn() };
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS); // a presented

    coordinator.setDesiredOpen('b', true); // displaces a
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // onDisplaced is delivered via microtask
    expect(a.onDisplaced).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // a's dismiss settles → b presents
    vi.advanceTimersByTime(SETTLE_MS); // b's present settles
    expect(coordinator.isPresented('b')).toBe(true);

    coordinator.setDesiredOpen('b', false); // displacer goes away
    vi.advanceTimersByTime(SETTLE_MS);

    // The displaced sheet was closed, not suspended: no resurrection.
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('displaces a sheet whose present is still in flight when the displacer wins the group', async () => {
    const a = { ...makeSheet(), onDisplaced: vi.fn() };
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    coordinator.setDesiredOpen('b', true); // while a's present is in flight
    await Promise.resolve();
    expect(a.onDisplaced).not.toHaveBeenCalled(); // nothing until a's present settles

    vi.advanceTimersByTime(SETTLE_MS); // a's present settles → pump displaces it
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(a.onDisplaced).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // a's dismiss settles → b presents
    vi.advanceTimersByTime(SETTLE_MS); // b's present settles
    coordinator.setDesiredOpen('b', false);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.present).toHaveBeenCalledTimes(1); // no resurrection here either
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('does not fire onDisplaced for a handoff whose first sheet already closed itself', async () => {
    const a = { ...makeSheet(), onDisplaced: vi.fn() };
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS); // a presented

    // The climb-actions pattern: the action closes its own sheet and opens the
    // next one. The parent drove the close — no displacement notification.
    coordinator.setDesiredOpen('a', false);
    coordinator.setDesiredOpen('b', true);
    await Promise.resolve();
    expect(a.onDisplaced).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SETTLE_MS); // a's dismiss settles
    expect(b.present).toHaveBeenCalledTimes(1);
  });
});

// The bridge consumers actually use. The selfDismissRef gate here is what tells a
// user pan-down apart from a coordinator-driven dismiss — a misclassification is
// exactly what would double-dismiss / present-over-dismiss and freeze the app.
type SheetApiMock = Record<
  'present' | 'dismiss' | 'snapToIndex' | 'snapToPosition' | 'expand' | 'collapse' | 'close' | 'forceClose',
  ReturnType<typeof vi.fn>
>;

function makeSheetApi(): SheetApiMock {
  return {
    present: vi.fn(),
    dismiss: vi.fn(),
    snapToIndex: vi.fn(),
    snapToPosition: vi.fn(),
    expand: vi.fn(),
    collapse: vi.fn(),
    close: vi.fn(),
    forceClose: vi.fn(),
  };
}

let managed: ReturnType<typeof useManagedSheet> | null = null;
let sheetApi: SheetApiMock;

function ManagedHarness({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const sheetRef = useRef(sheetApi as unknown as BottomSheetMethods);
  managed = useManagedSheet({ open, sheetRef: sheetRef as RefObject<BottomSheetMethods | null>, onClose });
  return null;
}

describe('useManagedSheet bridge', () => {
  beforeEach(() => {
    managed = null;
    sheetApi = makeSheetApi();
  });

  it('presents on open (snapToIndex 0) and dismisses via the coordinator handle', () => {
    render(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true })));
    expect(sheetApi.snapToIndex).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(SETTLE_MS);
    act(() => {
      managed?.handle.dismiss();
    });
    expect(sheetApi.dismiss).toHaveBeenCalledTimes(1);
  });

  it('a user pan-down (onChange(-1)) fires onClose', () => {
    const onClose = vi.fn();
    render(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true, onClose })));
    vi.advanceTimersByTime(SETTLE_MS);
    act(() => {
      managed?.onChange(-1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a coordinator-driven dismiss does NOT fire onClose (selfDismissRef gate)', () => {
    const onClose = vi.fn();
    render(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true, onClose })));
    vi.advanceTimersByTime(SETTLE_MS);
    act(() => {
      managed?.handle.dismiss(); // sets selfDismissRef + drives the native dismiss
    });
    act(() => {
      managed?.onChange(-1); // the synchronous native callback that dismiss() triggers
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a displacement fires onClose exactly once so the controlled parent clears its open state', async () => {
    const onCloseA = vi.fn();
    let managedA: ReturnType<typeof useManagedSheet> | null = null;
    let managedB: ReturnType<typeof useManagedSheet> | null = null;
    const sheetApiA = makeSheetApi();
    const sheetApiB = makeSheetApi();

    function SheetA({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApiA as unknown as BottomSheetMethods);
      managedA = useManagedSheet({
        open,
        sheetRef: sheetRef as RefObject<BottomSheetMethods | null>,
        onClose: onCloseA,
      });
      return null;
    }
    function SheetB({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApiB as unknown as BottomSheetMethods);
      managedB = useManagedSheet({ open, sheetRef: sheetRef as RefObject<BottomSheetMethods | null> });
      return null;
    }
    function Harness({ openB }: { openB: boolean }) {
      return createElement(
        SheetPresentationProvider,
        null,
        createElement(SheetA, { open: true }),
        createElement(SheetB, { open: openB }),
      );
    }

    const { rerender } = render(createElement(Harness, { openB: false }));
    vi.advanceTimersByTime(SETTLE_MS); // A presented

    rerender(createElement(Harness, { openB: true })); // B displaces A
    await act(async () => {}); // flush the onDisplaced microtask
    // The parent is told A is closed (this is what clears e.g. isTickBarActive)...
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(sheetApiA.dismiss).toHaveBeenCalledTimes(1);

    // ...and the native close callback the dismiss triggers is still classified
    // as coordinator-driven, so onClose does not fire a second time.
    act(() => {
      managedA?.onChange(-1);
    });
    expect(onCloseA).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // A dismiss settles
    expect(sheetApiB.snapToIndex).toHaveBeenCalledWith(0); // B presents
    vi.advanceTimersByTime(SETTLE_MS); // B present settles

    // B closes → A must NOT come back.
    act(() => {
      managedB?.handle.dismiss();
    });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(sheetApiA.snapToIndex).toHaveBeenCalledTimes(1); // only the original present
  });
});
