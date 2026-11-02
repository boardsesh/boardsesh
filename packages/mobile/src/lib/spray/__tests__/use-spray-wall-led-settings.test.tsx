// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../preference-store', () => ({
  getPreference: preferences.get,
  setPreference: preferences.set,
}));

import { useSprayWallLedSettings, type SprayWallLedSettings } from '../use-spray-wall-led-settings';

const configured: SprayWallLedSettings = {
  version: 1,
  enabled: true,
  controller: { type: 'wled', url: 'http://wall.local' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  preferences.get.mockReset().mockResolvedValue(null);
  preferences.set.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('device-local spray wall LED settings', () => {
  it('starts disabled only after reading a missing record, without writing defaults', async () => {
    const read = deferred<unknown>();
    preferences.get.mockReturnValueOnce(read.promise);
    const { result } = renderHook(() => useSprayWallLedSettings('wall-one'));
    expect(result.current.loading).toBe(true);
    expect(result.current.settings).toBeNull();
    expect(await result.current.save(configured)).toBe(false);
    await act(async () => read.resolve(null));
    expect(result.current.settings).toEqual({
      version: 1,
      enabled: false,
      controller: { type: 'wled', url: '' },
    });
    expect(preferences.get).toHaveBeenCalledWith('sprayWallLedSettings:wall-one', { strictParsing: true });
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it('retains the controller URL after disabling and reopening the wall', async () => {
    let stored: SprayWallLedSettings = configured;
    preferences.get.mockImplementation(async () => stored);
    preferences.set.mockImplementation(async (_key: string, next: SprayWallLedSettings) => {
      stored = next;
    });
    const first = renderHook(() => useSprayWallLedSettings('wall-one'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.save({ ...configured, enabled: false })).toBe(true);
    });
    first.unmount();
    const reopened = renderHook(() => useSprayWallLedSettings('wall-one'));
    await waitFor(() => expect(reopened.result.current.loading).toBe(false));
    expect(reopened.result.current.settings).toEqual({ ...configured, enabled: false });
    expect(preferences.set).toHaveBeenCalledWith('sprayWallLedSettings:wall-one', {
      ...configured,
      enabled: false,
    });
  });

  it('allows retry after a failed read and refuses to overwrite unread settings', async () => {
    preferences.get.mockRejectedValueOnce(new Error('locked storage')).mockResolvedValueOnce(configured);
    const { result } = renderHook(() => useSprayWallLedSettings('wall-one'));
    await waitFor(() => expect(result.current.error).toBe('load'));
    expect(result.current.settings).toBeNull();
    expect(await result.current.save(configured)).toBe(false);
    expect(preferences.set).not.toHaveBeenCalled();
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.settings).toEqual(configured));
    expect(result.current.error).toBeNull();
  });

  it.each([
    { version: 2, enabled: true, controller: { type: 'wled', url: 'http://wall.local' } },
    { version: 1, enabled: 'yes', controller: { type: 'wled', url: 'http://wall.local' } },
    { version: 1, enabled: true, controller: { type: 'unknown', url: 'http://wall.local' } },
  ])('preserves unsupported or malformed records: %j', async (stored) => {
    preferences.get.mockResolvedValue(stored);
    const { result } = renderHook(() => useSprayWallLedSettings('wall-one'));
    await waitFor(() => expect(result.current.error).toBe('load'));
    expect(await result.current.save(configured)).toBe(false);
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it('keeps the last saved settings after a failed write and accepts a retry', async () => {
    preferences.get.mockResolvedValue(configured);
    preferences.set.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useSprayWallLedSettings('wall-one'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const disabled = { ...configured, enabled: false };
    await act(async () => {
      expect(await result.current.save(disabled)).toBe(false);
    });
    expect(result.current.settings).toEqual(configured);
    expect(result.current.error).toBe('save');
    expect(result.current.saving).toBe(false);
    await act(async () => {
      expect(await result.current.save(disabled)).toBe(true);
    });
    expect(result.current.settings).toEqual(disabled);
    expect(result.current.error).toBeNull();
  });

  it('refuses a second save and reload while a write is pending', async () => {
    const write = deferred<void>();
    preferences.set.mockReturnValueOnce(write.promise);
    const { result } = renderHook(() => useSprayWallLedSettings('wall-one'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let firstSave!: Promise<boolean>;
    await act(async () => {
      firstSave = result.current.save(configured);
      expect(await result.current.save({ ...configured, enabled: false })).toBe(false);
      result.current.reload();
    });
    expect(result.current.saving).toBe(true);
    expect(preferences.set).toHaveBeenCalledTimes(1);
    expect(preferences.get).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve());
    expect(await firstSave).toBe(true);
    expect(result.current.settings).toEqual(configured);
  });

  it('ignores an old wall read that resolves after switching walls', async () => {
    const oldRead = deferred<unknown>();
    preferences.get.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(null);
    const { result, rerender } = renderHook(({ wall }) => useSprayWallLedSettings(wall), {
      initialProps: { wall: 'wall-one' },
    });
    await waitFor(() => expect(preferences.get).toHaveBeenCalledTimes(1));
    rerender({ wall: 'wall-two' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => oldRead.resolve(configured));
    expect(result.current.settings?.enabled).toBe(false);
    expect(result.current.settings?.controller.url).toBe('');
  });

  it('does not publish an old wall save into the newly selected wall', async () => {
    const oldWrite = deferred<void>();
    preferences.set.mockReturnValueOnce(oldWrite.promise);
    const { result, rerender } = renderHook(({ wall }) => useSprayWallLedSettings(wall), {
      initialProps: { wall: 'wall-one' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let pendingSave!: Promise<boolean>;
    act(() => {
      pendingSave = result.current.save(configured);
    });
    rerender({ wall: 'wall-two' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => oldWrite.resolve());
    expect(await pendingSave).toBe(false);
    expect(result.current.settings?.controller.url).toBe('');
    expect(result.current.saving).toBe(false);
  });

  it('waits for a pending save after the editor unmounts and reopens', async () => {
    const write = deferred<void>();
    let stored: SprayWallLedSettings | null = null;
    preferences.get.mockImplementation(async () => stored);
    preferences.set.mockImplementation(async (_key: string, settings: SprayWallLedSettings) => {
      await write.promise;
      stored = settings;
    });
    const first = renderHook(() => useSprayWallLedSettings('wall-one'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => {
      void first.result.current.save(configured);
    });
    first.unmount();
    const reopened = renderHook(() => useSprayWallLedSettings('wall-one'));
    expect(reopened.result.current.loading).toBe(true);
    expect(preferences.get).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve());
    await waitFor(() => expect(reopened.result.current.settings).toEqual(configured));
  });

  it('waits for an old write before reloading the same wall after navigation', async () => {
    const write = deferred<void>();
    let stored: SprayWallLedSettings | null = null;
    preferences.get.mockImplementation(async () => stored);
    preferences.set.mockImplementation(async (_key: string, settings: SprayWallLedSettings) => {
      await write.promise;
      stored = settings;
    });
    const { result, rerender } = renderHook(({ wall }) => useSprayWallLedSettings(wall), {
      initialProps: { wall: 'wall-one' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      void result.current.save(configured);
    });
    rerender({ wall: 'wall-two' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ wall: 'wall-one' });
    expect(result.current.loading).toBe(true);
    await act(async () => write.resolve());
    await waitFor(() => expect(result.current.settings).toEqual(configured));
    expect(result.current.loading).toBe(false);
  });
});
