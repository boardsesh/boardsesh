// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, useRef, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import { SheetPresentationProvider, useManagedSheet } from '../sheet-presentation-provider';

const WEB_SETTLE_MS = 350;

type SheetApiMock = Record<
  'present' | 'dismiss' | 'snapToIndex' | 'snapToPosition' | 'expand' | 'collapse' | 'close' | 'forceClose',
  ReturnType<typeof vi.fn>
>;

function createSheetApi(): SheetApiMock {
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('__DEV__', false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('web sheet presentation', () => {
  it('opens after an initial false state and treats a later user dismissal as a close', () => {
    const sheetApi = createSheetApi();
    const onClose = vi.fn();
    const onFullyDismissed = vi.fn();
    let managed: ReturnType<typeof useManagedSheet> | null = null;

    function SheetHarness({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApi as unknown as BottomSheetMethods);
      managed = useManagedSheet({
        open,
        sheetRef: sheetRef as RefObject<BottomSheetMethods | null>,
        onClose,
        onFullyDismissed,
      });
      return null;
    }

    function Harness({ open }: { open: boolean }) {
      return createElement(SheetPresentationProvider, null, createElement(SheetHarness, { open }));
    }

    const { rerender } = render(createElement(Harness, { open: false }));
    expect(sheetApi.snapToIndex).not.toHaveBeenCalled();
    expect(sheetApi.dismiss).not.toHaveBeenCalled();

    rerender(createElement(Harness, { open: true }));
    expect(sheetApi.snapToIndex).toHaveBeenCalledWith(0);
    void act(() => vi.advanceTimersByTime(WEB_SETTLE_MS));

    act(() => managed?.onChange(-1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sheetApi.dismiss).not.toHaveBeenCalled();

    act(() => managed?.onFullyDismissed());
    expect(onFullyDismissed).toHaveBeenCalledTimes(1);
    act(() => managed?.onFullyDismissed());
    expect(onFullyDismissed).toHaveBeenCalledTimes(1);
  });

  it('does not report a coordinator-driven dismissal as a user close', () => {
    const sheetApi = createSheetApi();
    const onClose = vi.fn();
    let managed: ReturnType<typeof useManagedSheet> | null = null;

    function SheetHarness({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApi as unknown as BottomSheetMethods);
      managed = useManagedSheet({
        open,
        sheetRef: sheetRef as RefObject<BottomSheetMethods | null>,
        onClose,
      });
      return null;
    }

    function Harness({ open }: { open: boolean }) {
      return createElement(SheetPresentationProvider, null, createElement(SheetHarness, { open }));
    }

    const { rerender } = render(createElement(Harness, { open: true }));
    void act(() => vi.advanceTimersByTime(WEB_SETTLE_MS));
    rerender(createElement(Harness, { open: false }));
    expect(sheetApi.dismiss).toHaveBeenCalledTimes(1);

    act(() => managed?.onChange(-1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses and closes a displaced sibling before presenting the replacement', async () => {
    const sheetApiA = createSheetApi();
    const sheetApiB = createSheetApi();
    const onCloseA = vi.fn();
    let managedA: ReturnType<typeof useManagedSheet> | null = null;
    let managedB: ReturnType<typeof useManagedSheet> | null = null;

    function SheetA() {
      const sheetRef = useRef(sheetApiA as unknown as BottomSheetMethods);
      managedA = useManagedSheet({
        open: true,
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
        createElement(SheetA),
        createElement(SheetB, { open: openB }),
      );
    }

    const { rerender } = render(createElement(Harness, { openB: false }));
    void act(() => vi.advanceTimersByTime(WEB_SETTLE_MS));

    rerender(createElement(Harness, { openB: true }));
    await act(async () => {});
    expect(sheetApiA.dismiss).toHaveBeenCalledTimes(1);
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(sheetApiB.snapToIndex).not.toHaveBeenCalled();

    act(() => managedA?.onChange(-1));
    expect(onCloseA).toHaveBeenCalledTimes(1);
    act(() => managedA?.onFullyDismissed());
    expect(sheetApiB.snapToIndex).toHaveBeenCalledWith(0);

    void act(() => vi.advanceTimersByTime(WEB_SETTLE_MS));
    act(() => managedB?.handle.dismiss());
    act(() => managedB?.onFullyDismissed());
    expect(sheetApiA.snapToIndex).toHaveBeenCalledTimes(1);
  });
});
