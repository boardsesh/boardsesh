// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';
import type { WaitForPresentationResult } from '../../providers/sheet-presentation-provider';
import { useSheetPresented } from '../use-sheet-presented';
function deferred() {
  let resolve!: (result: WaitForPresentationResult) => void;
  const promise = new Promise<WaitForPresentationResult>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const layout = (width = 390, height = 500) =>
  ({
    nativeEvent: { layout: { width, height, x: 0, y: 0 } },
  }) as LayoutChangeEvent;
describe('sheet presentation observation', () => {
  it('waits beyond native open and layout until the coordinator settles', async () => {
    const pending = deferred();
    const wait = vi.fn(() => pending.promise);
    const onPresented = vi.fn();
    const hook = renderHook(() => useSheetPresented(true, wait, onPresented));
    expect(wait).not.toHaveBeenCalled();
    act(() => hook.result.current(layout(0, 0)));
    expect(wait).not.toHaveBeenCalled();
    act(() => hook.result.current(layout()));
    expect(wait).toHaveBeenCalledOnce();
    expect(onPresented).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ status: 'presented' }));
    expect(onPresented).toHaveBeenCalledOnce();
    act(() => hook.result.current(layout()));
    expect(onPresented).toHaveBeenCalledOnce();
  });
  it('accepts layout before opening but does not observe a closed sheet', async () => {
    const wait = vi.fn(async () => ({ status: 'presented' as const }));
    const onPresented = vi.fn();
    const hook = renderHook(({ open }) => useSheetPresented(open, wait, onPresented), {
      initialProps: { open: false },
    });
    act(() => hook.result.current(layout()));
    expect(wait).not.toHaveBeenCalled();
    await act(async () => hook.rerender({ open: true }));
    expect(onPresented).toHaveBeenCalledOnce();
  });
  it('ignores an aborted transition and stale completion after closing', async () => {
    const pending = deferred();
    const onPresented = vi.fn();
    const wait = vi.fn(() => pending.promise);
    const hook = renderHook(({ open }) => useSheetPresented(open, wait, onPresented), { initialProps: { open: true } });
    act(() => hook.result.current(layout()));
    hook.rerender({ open: false });
    await act(async () => pending.resolve({ status: 'presented' }));
    expect(onPresented).not.toHaveBeenCalled();
    wait.mockResolvedValue({ status: 'aborted' });
    await act(async () => hook.rerender({ open: true }));
    expect(onPresented).not.toHaveBeenCalled();
  });
  it('does not subscribe or change state without a presentation observer', () => {
    const wait = vi.fn();
    const hook = renderHook(() => useSheetPresented(true, wait));
    act(() => hook.result.current(layout()));
    expect(wait).not.toHaveBeenCalled();
  });
});
