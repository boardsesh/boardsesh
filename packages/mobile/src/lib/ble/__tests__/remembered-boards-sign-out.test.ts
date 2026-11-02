import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sign-out forgets every board this phone remembers, with or without a hook
// mounted to hear it.

const mockStores = vi.hoisted(() => ({
  clearStoredLastConnectedBoard: vi.fn(async () => {}),
  setStoredKnownBoardDevices: vi.fn(async () => {}),
}));
vi.mock('../last-connected-board-store', () => ({
  clearStoredLastConnectedBoard: mockStores.clearStoredLastConnectedBoard,
}));
vi.mock('../known-board-devices-store', () => ({
  setStoredKnownBoardDevices: mockStores.setStoredKnownBoardDevices,
}));

import { forgetRememberedBoardsOnSignOut, subscribeRememberedBoardsSignOut } from '../remembered-boards-sign-out';

beforeEach(() => {
  mockStores.clearStoredLastConnectedBoard.mockReset().mockResolvedValue(undefined);
  mockStores.setStoredKnownBoardDevices.mockReset().mockResolvedValue(undefined);
});

describe('forgetRememberedBoardsOnSignOut', () => {
  it('clears the single record and every per-board handle with nobody listening', async () => {
    await forgetRememberedBoardsOnSignOut();
    expect(mockStores.clearStoredLastConnectedBoard).toHaveBeenCalledOnce();
    expect(mockStores.setStoredKnownBoardDevices).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('tells every listener, even after one throws, and stops telling one that left', async () => {
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const listening = vi.fn();
    const leaving = vi.fn();
    const unsubscribeThrowing = subscribeRememberedBoardsSignOut(throwing);
    const unsubscribeListening = subscribeRememberedBoardsSignOut(listening);
    subscribeRememberedBoardsSignOut(leaving)();

    await forgetRememberedBoardsOnSignOut();

    expect(throwing).toHaveBeenCalledOnce();
    expect(listening).toHaveBeenCalledOnce();
    expect(leaving).not.toHaveBeenCalled();
    expect(mockStores.clearStoredLastConnectedBoard).toHaveBeenCalledOnce();
    unsubscribeThrowing();
    unsubscribeListening();
  });

  it('never rejects when storage fails: a sign-out must not throw', async () => {
    mockStores.clearStoredLastConnectedBoard.mockRejectedValue(new Error('disk full'));
    mockStores.setStoredKnownBoardDevices.mockRejectedValue(new Error('disk full'));
    await expect(forgetRememberedBoardsOnSignOut()).resolves.toBeUndefined();
  });
});
