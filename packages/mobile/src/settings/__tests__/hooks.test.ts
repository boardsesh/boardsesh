import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { getSetting, setSetting, getAllSettings, resetAllSettings } from '../hooks';
import { DEFAULT_SETTINGS } from '../defaults';

describe('settings', () => {
  beforeEach(() => {
    mockStorage.clear();
    // getAllSettings() memoises its snapshot at module level; tests below poke
    // mockStorage directly (bypassing setSetting/emitChange), so bust the cache.
    resetAllSettings();
  });

  describe('getSetting', () => {
    it('returns default when no value is stored', () => {
      expect(getSetting('autoConnectBle')).toBe(true);
      expect(getSetting('theme')).toBe('system');
      expect(getSetting('defaultBoardUuid')).toBeNull();
      expect(getSetting('syncEnabledBoards')).toEqual([]);
    });

    it('returns stored value parsed from JSON', () => {
      mockStorage.set('autoConnectBle', 'false');
      expect(getSetting('autoConnectBle')).toBe(false);
    });

    it('returns stored string value parsed from JSON', () => {
      mockStorage.set('theme', '"dark"');
      expect(getSetting('theme')).toBe('dark');
    });

    it('returns stored array value parsed from JSON', () => {
      mockStorage.set('syncEnabledBoards', '["board-1","board-2"]');
      expect(getSetting('syncEnabledBoards')).toEqual(['board-1', 'board-2']);
    });

    it('returns default on invalid JSON', () => {
      mockStorage.set('autoConnectBle', 'not-json');
      expect(getSetting('autoConnectBle')).toBe(DEFAULT_SETTINGS.autoConnectBle);
    });

    it('returns default on empty string JSON', () => {
      mockStorage.set('theme', '');
      expect(getSetting('theme')).toBe(DEFAULT_SETTINGS.theme);
    });
  });

  describe('setSetting', () => {
    it('writes JSON-stringified boolean to storage', () => {
      setSetting('autoConnectBle', false);
      expect(mockStorage.get('autoConnectBle')).toBe('false');
    });

    it('writes JSON-stringified string to storage', () => {
      setSetting('theme', 'dark');
      expect(mockStorage.get('theme')).toBe('"dark"');
    });

    it('writes JSON-stringified array to storage', () => {
      setSetting('syncEnabledBoards', ['a', 'b']);
      expect(mockStorage.get('syncEnabledBoards')).toBe('["a","b"]');
    });

    it('writes JSON-stringified null to storage', () => {
      setSetting('defaultBoardUuid', null);
      expect(mockStorage.get('defaultBoardUuid')).toBe('null');
    });

    it('overwrites a previously stored value', () => {
      setSetting('theme', 'dark');
      setSetting('theme', 'light');
      expect(mockStorage.get('theme')).toBe('"light"');
    });
  });

  describe('getAllSettings', () => {
    it('returns all defaults when nothing is stored', () => {
      expect(getAllSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('merges stored values with defaults', () => {
      mockStorage.set('theme', '"dark"');
      mockStorage.set('autoConnectBle', 'false');

      const settings = getAllSettings();

      expect(settings.theme).toBe('dark');
      expect(settings.autoConnectBle).toBe(false);
      expect(settings.keepScreenAwake).toBe(DEFAULT_SETTINGS.keepScreenAwake);
      expect(settings.hapticFeedbackEnabled).toBe(DEFAULT_SETTINGS.hapticFeedbackEnabled);
      expect(settings.notifySessionInvites).toBe(DEFAULT_SETTINGS.notifySessionInvites);
      expect(settings.notifyClimbComments).toBe(DEFAULT_SETTINGS.notifyClimbComments);
      expect(settings.defaultBoardUuid).toBe(DEFAULT_SETTINGS.defaultBoardUuid);
      expect(settings.syncEnabledBoards).toEqual(DEFAULT_SETTINGS.syncEnabledBoards);
    });

    it('ignores invalid JSON entries and uses defaults', () => {
      mockStorage.set('theme', 'broken{json');
      mockStorage.set('autoConnectBle', 'false');

      const settings = getAllSettings();

      expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
      expect(settings.autoConnectBle).toBe(false);
    });

    it('returns the same reference on consecutive calls (cached snapshot)', () => {
      const first = getAllSettings();
      const second = getAllSettings();
      expect(second).toBe(first);
    });

    it('returns a new reference after a setSetting (cache busted)', () => {
      const before = getAllSettings();
      setSetting('theme', 'dark');
      const after = getAllSettings();
      expect(after).not.toBe(before);
      expect(after.theme).toBe('dark');
    });

    it('returns a new reference after resetAllSettings (cache busted)', () => {
      const before = getAllSettings();
      resetAllSettings();
      const after = getAllSettings();
      expect(after).not.toBe(before);
    });
  });

  describe('resetAllSettings', () => {
    it('deletes all settings keys from storage', () => {
      mockStorage.set('theme', '"dark"');
      mockStorage.set('autoConnectBle', 'false');
      mockStorage.set('keepScreenAwake', 'false');

      resetAllSettings();

      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        expect(mockStorage.has(key)).toBe(false);
      }
    });

    it('leaves storage empty after reset', () => {
      setSetting('theme', 'dark');
      setSetting('autoConnectBle', false);

      resetAllSettings();

      expect(mockStorage.size).toBe(0);
    });

    it('returns defaults after reset', () => {
      setSetting('theme', 'dark');
      setSetting('hapticFeedbackEnabled', false);

      resetAllSettings();

      expect(getAllSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('wipes keys that are not part of DEFAULT_SETTINGS', () => {
      setSetting('theme', 'dark');
      // A stale key left over from a previous app version, not in DEFAULT_SETTINGS.
      mockStorage.set('legacyOrphanKey', '"stale"');

      resetAllSettings();

      expect(mockStorage.has('legacyOrphanKey')).toBe(false);
      expect(mockStorage.size).toBe(0);
    });
  });

  describe('setSetting then getSetting roundtrip', () => {
    it('roundtrips a boolean', () => {
      setSetting('keepScreenAwake', false);
      expect(getSetting('keepScreenAwake')).toBe(false);
    });

    it('roundtrips a string', () => {
      setSetting('theme', 'light');
      expect(getSetting('theme')).toBe('light');
    });

    it('roundtrips an array', () => {
      const boards = ['uuid-1', 'uuid-2', 'uuid-3'];
      setSetting('syncEnabledBoards', boards);
      expect(getSetting('syncEnabledBoards')).toEqual(boards);
    });

    it('roundtrips null', () => {
      setSetting('defaultBoardUuid', 'some-uuid');
      expect(getSetting('defaultBoardUuid')).toBe('some-uuid');
      setSetting('defaultBoardUuid', null);
      expect(getSetting('defaultBoardUuid')).toBeNull();
    });
  });
});
