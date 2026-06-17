// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const setMock = vi.fn();
vi.mock('../preference-store', () => ({
  getPreference: (key: string) => getMock(key),
  setPreference: (key: string, value: unknown) => setMock(key, value),
  removePreference: vi.fn(),
}));

import {
  dismissAccessory,
  resetAccessoryDismiss,
  useDismissedAccessoryUuid,
  __resetAccessoryDismissStoreForTests,
} from '../accessory-dismiss-store';

const STORAGE_KEY = 'boardsesh_accessory_dismiss_v1';

describe('accessory-dismiss-store', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    __resetAccessoryDismissStoreForTests();
  });

  it('starts null and hydrates a persisted dismissed uuid from storage', async () => {
    getMock.mockResolvedValue({ dismissedQueueItemUuid: 'climb-1' });
    const { result } = renderHook(() => useDismissedAccessoryUuid());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('climb-1'));
    expect(getMock).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('hydrates to null when nothing is stored', async () => {
    getMock.mockResolvedValue(null);
    const { result } = renderHook(() => useDismissedAccessoryUuid());
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('dismissAccessory sets the uuid and persists it', async () => {
    getMock.mockResolvedValue(null);
    const { result } = renderHook(() => useDismissedAccessoryUuid());
    await waitFor(() => expect(result.current).toBeNull());
    act(() => dismissAccessory('climb-2'));
    expect(result.current).toBe('climb-2');
    expect(setMock).toHaveBeenCalledWith(STORAGE_KEY, { dismissedQueueItemUuid: 'climb-2' });
  });

  it('resetAccessoryDismiss clears the uuid and persists null', async () => {
    getMock.mockResolvedValue({ dismissedQueueItemUuid: 'climb-3' });
    const { result } = renderHook(() => useDismissedAccessoryUuid());
    await waitFor(() => expect(result.current).toBe('climb-3'));
    act(() => resetAccessoryDismiss());
    expect(result.current).toBeNull();
    expect(setMock).toHaveBeenCalledWith(STORAGE_KEY, { dismissedQueueItemUuid: null });
  });

  it('a dismiss before hydration wins over the stale persisted value', async () => {
    // Storage holds an old dismissal, but the user dismisses a new climb before
    // the async read resolves — the explicit choice must not be clobbered.
    let resolveStored: (value: { dismissedQueueItemUuid: string } | null) => void = () => {};
    getMock.mockReturnValue(
      new Promise((resolve) => {
        resolveStored = resolve;
      }),
    );
    const { result } = renderHook(() => useDismissedAccessoryUuid());
    act(() => dismissAccessory('fresh'));
    expect(result.current).toBe('fresh');
    await act(async () => {
      resolveStored({ dismissedQueueItemUuid: 'stale' });
    });
    expect(result.current).toBe('fresh');
  });
});
