// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const confirm = vi.hoisted(() => vi.fn());
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { useUnsavedSheetGuard } from '../use-unsaved-sheet-guard';

beforeEach(() => {
  confirm.mockReset();
});
describe('unsaved native sheet guard', () => {
  it('permits clean dismissal and locks dirty gesture dismissal', async () => {
    const onClose = vi.fn();
    const { result, rerender } = renderHook(({ dirty }) => useUnsavedSheetGuard({ visible: true, dirty, onClose }), {
      initialProps: { dirty: false },
    });
    expect(result.current.enablePanDownToClose).toBe(true);
    await act(() => result.current.requestClose());
    expect(onClose).toHaveBeenCalledOnce();
    rerender({ dirty: true });
    expect(result.current.enablePanDownToClose).toBe(false);
  });

  it('keeps edits on cancel and discards only after explicit confirmation', async () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useUnsavedSheetGuard({ visible: true, dirty: true, onClose }));
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(() => result.current.requestClose());
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, cancelLabel: 'unsavedChanges.keepEditing' }),
    );
    await act(() => result.current.requestClose());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects a stale discard answer when the edited record changes', async () => {
    let resolve: (discard: boolean) => void = () => {};
    confirm.mockImplementation(
      () =>
        new Promise<boolean>((finish) => {
          resolve = finish;
        }),
    );
    const onClose = vi.fn();
    const onDiscard = vi.fn();
    const { result, rerender } = renderHook(
      ({ scope }) => useUnsavedSheetGuard({ visible: true, dirty: true, scope, onClose, onDiscard }),
      { initialProps: { scope: 'first' } },
    );
    let pending: Promise<void>;
    act(() => {
      pending = result.current.requestClose();
    });
    rerender({ scope: 'second' });
    await act(async () => {
      resolve(true);
      await pending!;
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('blocks cancellation while saving and rejects a late answer after reopening', async () => {
    let resolve: (discard: boolean) => void = () => {};
    confirm.mockImplementation(
      () =>
        new Promise<boolean>((finish) => {
          resolve = finish;
        }),
    );
    const onClose = vi.fn();
    const { result, rerender } = renderHook(
      ({ visible, busy }) => useUnsavedSheetGuard({ visible, busy, dirty: true, onClose }),
      { initialProps: { visible: true, busy: true } },
    );
    await act(() => result.current.requestClose());
    expect(confirm).not.toHaveBeenCalled();
    rerender({ visible: true, busy: false });
    let pending: Promise<void>;
    act(() => {
      pending = result.current.requestClose();
    });
    await act(() => result.current.requestClose());
    expect(confirm).toHaveBeenCalledOnce();
    rerender({ visible: false, busy: false });
    rerender({ visible: true, busy: false });
    await act(async () => {
      resolve(true);
      await pending!;
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
