import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sign-out forgets every board this phone remembers, with or without a hook
// mounted to hear it.

const mockStores = vi.hoisted(() => ({
  clearStoredLastConnectedBoard: vi.fn(async () => {}),
  setStoredKnownBoardDevices: vi.fn(async () => {}),
  clearRecognizedBoardDevices: vi.fn(async () => {}),
}));
vi.mock('../last-connected-board-store', () => ({
  clearStoredLastConnectedBoard: mockStores.clearStoredLastConnectedBoard,
}));
vi.mock('../known-board-devices-store', () => ({
  setStoredKnownBoardDevices: mockStores.setStoredKnownBoardDevices,
}));
vi.mock('../recognized-board-devices-store', () => ({
  clearRecognizedBoardDevices: mockStores.clearRecognizedBoardDevices,
}));
const pendingRecognition = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock('../../boards/pending-board-recognition', () => ({
  clearPendingBoardRecognition: pendingRecognition.clear,
}));

import { forgetRememberedBoardsOnSignOut, subscribeRememberedBoardsSignOut } from '../remembered-boards-sign-out';

beforeEach(() => {
  pendingRecognition.clear.mockClear();
  mockStores.clearStoredLastConnectedBoard.mockReset().mockResolvedValue(undefined);
  mockStores.setStoredKnownBoardDevices.mockReset().mockResolvedValue(undefined);
  mockStores.clearRecognizedBoardDevices.mockReset().mockResolvedValue(undefined);
});

describe('forgetRememberedBoardsOnSignOut', () => {
  it('clears the single record and every per-board handle with nobody listening', async () => {
    await forgetRememberedBoardsOnSignOut();
    expect(mockStores.clearStoredLastConnectedBoard).toHaveBeenCalledOnce();
    expect(mockStores.setStoredKnownBoardDevices).toHaveBeenCalledExactlyOnceWith([]);
    // The boxes this phone names by Bluetooth id were bound by the same account.
    expect(mockStores.clearRecognizedBoardDevices).toHaveBeenCalledOnce();
    // A box still waiting for its board must not be named by the next account.
    expect(pendingRecognition.clear).toHaveBeenCalledOnce();
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
    mockStores.clearRecognizedBoardDevices.mockRejectedValue(new Error('disk full'));
    await expect(forgetRememberedBoardsOnSignOut()).resolves.toBeUndefined();
  });
});
