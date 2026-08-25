// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBleFrameWriter } from '../use-ble-frame-writer';
import type { SendFramesToBoard } from '../use-board-bluetooth';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useBleFrameWriter', () => {
  it('writes the frame it is handed', async () => {
    const send = vi.fn().mockResolvedValue(true) as unknown as SendFramesToBoard;
    renderHook(() => useBleFrameWriter({ frame: 'p1r42', send, mirrored: false, resetKey: 'climb-1' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('p1r42', false));
  });

  it('writes nothing while the frame is null', async () => {
    const send = vi.fn().mockResolvedValue(true) as unknown as SendFramesToBoard;
    renderHook(() => useBleFrameWriter({ frame: null, send, mirrored: false, resetKey: 'climb-1' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a repeat of the frame already on the wall', async () => {
    const send = vi.fn().mockResolvedValue(true) as unknown as SendFramesToBoard;
    const { rerender } = renderHook(
      (props: { frame: string }) =>
        useBleFrameWriter({ frame: props.frame, send, mirrored: false, resetKey: 'climb-1' }),
      { initialProps: { frame: 'p1r42' } },
    );

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    rerender({ frame: 'p1r42' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst to the newest frame instead of queueing every one', async () => {
    // The wall must never lag behind on-screen playback: while one write is in
    // flight, intermediate frames are dropped and only the latest is sent next.
    const firstWrite = deferred();
    const send = vi
      .fn()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(true) as unknown as SendFramesToBoard;

    const { rerender } = renderHook(
      (props: { frame: string }) =>
        useBleFrameWriter({ frame: props.frame, send, mirrored: false, resetKey: 'climb-1' }),
      { initialProps: { frame: 'p1r42' } },
    );

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    rerender({ frame: 'p2r42' });
    rerender({ frame: 'p3r42' });
    rerender({ frame: 'p4r42' });
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstWrite.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(send).mock.calls[1][0]).toBe('p4r42');
  });

  it('re-flushes the same frame after the reset key changes', async () => {
    const send = vi.fn().mockResolvedValue(true) as unknown as SendFramesToBoard;
    const { rerender } = renderHook(
      (props: { resetKey: string }) =>
        useBleFrameWriter({ frame: 'p1r42', send, mirrored: false, resetKey: props.resetKey }),
      { initialProps: { resetKey: 'climb-1' } },
    );

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    rerender({ resetKey: 'climb-2' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it('reports each write so a wall-state dedup can invalidate itself', async () => {
    const send = vi.fn().mockResolvedValue(true) as unknown as SendFramesToBoard;
    const onWrite = vi.fn();
    renderHook(() => useBleFrameWriter({ frame: 'p1r42', send, mirrored: false, resetKey: 'draft-1', onWrite }));

    await waitFor(() => expect(onWrite).toHaveBeenCalledTimes(1));
  });

  it('reports the write attempt even when the write then throws', async () => {
    // Deliberate: after a failed write the wall-state record is untrustworthy,
    // so it must be invalidated whether or not the bytes landed.
    const send = vi.fn().mockRejectedValue(new Error('link dropped')) as unknown as SendFramesToBoard;
    const onWrite = vi.fn();
    renderHook(() => useBleFrameWriter({ frame: 'p1r42', send, mirrored: false, resetKey: 'draft-1', onWrite }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it('keeps draining after a failed write', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('link dropped'))
      .mockResolvedValue(true) as unknown as SendFramesToBoard;

    const { rerender } = renderHook(
      (props: { frame: string }) =>
        useBleFrameWriter({ frame: props.frame, send, mirrored: false, resetKey: 'climb-1' }),
      { initialProps: { frame: 'p1r42' } },
    );

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    rerender({ frame: 'p2r42' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });
});
