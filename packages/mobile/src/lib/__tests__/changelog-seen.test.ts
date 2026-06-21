import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the secure-store adapter (the seam) rather than expo-secure-store.
const getMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();
vi.mock('../preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: (key: string) => getMock(key),
    set: (key: string, value: unknown) => setMock(key, value),
    remove: (key: string) => removeMock(key),
  },
}));

import { CHANGELOG_LAST_SEEN_KEY } from '@boardsesh/key-value-storage';
import { getLastSeenChangelogDate, markChangelogSeen, hasUnseenChangelog } from '../changelog-seen';

describe('changelog seen storage', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
  });

  describe('getLastSeenChangelogDate', () => {
    it('returns the stored ISO date', async () => {
      getMock.mockResolvedValue('2026-06-19T11:30:00.000Z');
      await expect(getLastSeenChangelogDate()).resolves.toBe('2026-06-19T11:30:00.000Z');
      expect(getMock).toHaveBeenCalledWith(CHANGELOG_LAST_SEEN_KEY);
    });

    it('returns null when nothing has been seen yet', async () => {
      getMock.mockResolvedValue(null);
      await expect(getLastSeenChangelogDate()).resolves.toBeNull();
    });

    it('returns null on a read error (a stray "New" pill beats a hidden update)', async () => {
      getMock.mockRejectedValue(new Error('keychain unavailable'));
      await expect(getLastSeenChangelogDate()).resolves.toBeNull();
    });
  });

  describe('markChangelogSeen', () => {
    it('persists the given date under the changelog key', async () => {
      setMock.mockResolvedValue(undefined);
      await markChangelogSeen('2026-06-19T11:30:00.000Z');
      expect(setMock).toHaveBeenCalledWith(CHANGELOG_LAST_SEEN_KEY, '2026-06-19T11:30:00.000Z');
    });

    it('propagates a write failure so the caller can report it', async () => {
      setMock.mockRejectedValue(new Error('keychain locked'));
      await expect(markChangelogSeen('2026-06-19T11:30:00.000Z')).rejects.toThrow('keychain locked');
    });
  });

  describe('hasUnseenChangelog', () => {
    it('is unseen when there is a latest entry and nothing has been seen', () => {
      expect(hasUnseenChangelog('2026-06-19T11:30:00.000Z', null)).toBe(true);
    });

    it('is unseen when the latest entry is newer than what was last seen', () => {
      expect(hasUnseenChangelog('2026-06-19T11:30:00.000Z', '2026-06-10T09:00:00.000Z')).toBe(true);
    });

    it('is seen when the latest entry equals what was last seen', () => {
      expect(hasUnseenChangelog('2026-06-19T11:30:00.000Z', '2026-06-19T11:30:00.000Z')).toBe(false);
    });

    it('is seen when what was last seen is newer than the latest entry', () => {
      expect(hasUnseenChangelog('2026-06-10T09:00:00.000Z', '2026-06-19T11:30:00.000Z')).toBe(false);
    });

    it('is never unseen when the changelog is empty (no latest entry)', () => {
      expect(hasUnseenChangelog(null, null)).toBe(false);
      expect(hasUnseenChangelog(null, '2026-06-19T11:30:00.000Z')).toBe(false);
    });

    describe('in screenshot mode', () => {
      const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
      beforeEach(() => {
        process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
      });
      afterEach(() => {
        if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
        else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
      });

      it('never reports unseen so captured screens omit the pill', () => {
        expect(hasUnseenChangelog('2026-06-19T11:30:00.000Z', null)).toBe(false);
      });
    });
  });
});
