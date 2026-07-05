import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockStorage = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString(key: string) {
      return mockStorage.get(key);
    },
    set(key: string, value: string) {
      mockStorage.set(key, value);
    },
    remove(key: string) {
      mockStorage.delete(key);
    },
    clearAll() {
      mockStorage.clear();
    },
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

import {
  offlineBoardKey,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
  parseOfflineBoardKey,
} from '../offline-board-key';
import { isOfflineBoardEnabled, setOfflineBoardEnabled } from '../use-offline-board';
import { getSetting, resetAllSettings } from '../hooks';

describe('offline board key', () => {
  it('encodes a scope as boardType:layoutId:sizeId', () => {
    expect(offlineBoardKey({ boardType: 'kilter', layoutId: 1, sizeId: 5 })).toBe('kilter:1:5');
  });

  it('round-trips a well-formed key', () => {
    const scope = { boardType: 'tension', layoutId: 8, sizeId: 10 };
    expect(parseOfflineBoardKey(offlineBoardKey(scope))).toEqual(scope);
  });

  it('derives the key from a board-like object', () => {
    const board = { boardType: 'kilter', layoutId: 1, sizeId: 5, name: 'ignored' };
    expect(offlineBoardKeyForBoard(board)).toBe('kilter:1:5');
    expect(offlineBoardScopeForBoard(board)).toEqual({ boardType: 'kilter', layoutId: 1, sizeId: 5 });
  });

  it('rejects malformed keys defensively', () => {
    expect(parseOfflineBoardKey('kilter')).toBeNull(); // legacy bare board type
    expect(parseOfflineBoardKey('kilter:1')).toBeNull(); // missing size
    expect(parseOfflineBoardKey('kilter:1:5:extra')).toBeNull(); // too many parts
    expect(parseOfflineBoardKey('kilter:a:5')).toBeNull(); // non-numeric layout
    expect(parseOfflineBoardKey('kilter:1:b')).toBeNull(); // non-numeric size
    expect(parseOfflineBoardKey(':1:5')).toBeNull(); // empty board type
    expect(parseOfflineBoardKey('kilter:1.5:5')).toBeNull(); // non-integer layout
  });
});

describe('setOfflineBoardEnabled / isOfflineBoardEnabled', () => {
  const scope = { boardType: 'kilter', layoutId: 1, sizeId: 5 };

  beforeEach(() => {
    mockStorage.clear();
    resetAllSettings();
  });

  it('adds and removes the scope key from syncEnabledBoards', () => {
    expect(isOfflineBoardEnabled(scope)).toBe(false);

    setOfflineBoardEnabled(scope, true);
    expect(getSetting('syncEnabledBoards')).toEqual(['kilter:1:5']);
    expect(isOfflineBoardEnabled(scope)).toBe(true);

    setOfflineBoardEnabled(scope, false);
    expect(getSetting('syncEnabledBoards')).toEqual([]);
    expect(isOfflineBoardEnabled(scope)).toBe(false);
  });

  it('is idempotent — enabling twice keeps one entry', () => {
    setOfflineBoardEnabled(scope, true);
    setOfflineBoardEnabled(scope, true);
    expect(getSetting('syncEnabledBoards')).toEqual(['kilter:1:5']);
  });

  it('leaves other enabled boards untouched when toggling one', () => {
    setOfflineBoardEnabled({ boardType: 'tension', layoutId: 8, sizeId: 10 }, true);
    setOfflineBoardEnabled(scope, true);
    expect(getSetting('syncEnabledBoards')).toEqual(['tension:8:10', 'kilter:1:5']);

    setOfflineBoardEnabled(scope, false);
    expect(getSetting('syncEnabledBoards')).toEqual(['tension:8:10']);
  });
});
