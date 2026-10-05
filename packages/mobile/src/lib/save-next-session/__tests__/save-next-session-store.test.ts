import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failReads: false,
  failWrites: false,
}));
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => {
    if (storage.failReads) throw new Error('read failed');
    return storage.values.has(key) ? structuredClone(storage.values.get(key)) : null;
  },
  setPreference: async (key: string, value: unknown) => {
    if (storage.failWrites) throw new Error('write failed');
    storage.values.set(key, structuredClone(value));
  },
}));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));

import {
  SAVED_CLIMB_NOTICE_MAX_SHOWS,
  claimSavedClimbNoticeShow,
  dismissSavedClimbsCard,
  ensureSaveNextSessionLoaded,
  getSaveNextSessionSnapshot,
  loadSaveNextSession,
  resetSaveNextSessionStoreForTests,
} from '../save-next-session-store';

const STORAGE_KEY = 'saveNextSession';

describe('save-next-session store', () => {
  beforeEach(() => {
    storage.values.clear();
    storage.failReads = false;
    storage.failWrites = false;
    reportErrorMock.mockClear();
    resetSaveNextSessionStoreForTests();
  });

  it('starts a phone with nothing shown and nothing dismissed', async () => {
    expect(getSaveNextSessionSnapshot()).toBeNull();

    await expect(loadSaveNextSession()).resolves.toEqual({ noticeShows: 0, cardDismissedAt: null });
    expect(getSaveNextSessionSnapshot()).toEqual({ noticeShows: 0, cardDismissedAt: null });
  });

  it('reads what an earlier launch stored', async () => {
    storage.values.set(STORAGE_KEY, { noticeShows: 2, cardDismissedAt: 77 });

    await expect(loadSaveNextSession()).resolves.toEqual({ noticeShows: 2, cardDismissedAt: 77 });
  });

  it.each([
    ['a negative count', { noticeShows: -1, cardDismissedAt: null }],
    ['a fractional count', { noticeShows: 1.5, cardDismissedAt: null }],
    ['a dismissal that is not a time', { noticeShows: 1, cardDismissedAt: 'yes' }],
    ['something that is not a record', 'nope'],
  ])('treats %s as a fresh phone', async (_label, stored) => {
    storage.values.set(STORAGE_KEY, stored);

    await expect(loadSaveNextSession()).resolves.toEqual({ noticeShows: 0, cardDismissedAt: null });
  });

  describe('the notice cap', () => {
    it('says no until the stored count has been read, and starts the read', async () => {
      expect(claimSavedClimbNoticeShow()).toBe(false);

      await vi.waitFor(() => expect(getSaveNextSessionSnapshot()).not.toBeNull());
      expect(getSaveNextSessionSnapshot()?.noticeShows).toBe(0);
    });

    it('hands out three shows, stores each, then stops', async () => {
      await loadSaveNextSession();

      for (let show = 1; show <= SAVED_CLIMB_NOTICE_MAX_SHOWS; show += 1) {
        expect(claimSavedClimbNoticeShow()).toBe(true);
        expect(getSaveNextSessionSnapshot()?.noticeShows).toBe(show);
      }
      expect(claimSavedClimbNoticeShow()).toBe(false);
      expect(getSaveNextSessionSnapshot()?.noticeShows).toBe(SAVED_CLIMB_NOTICE_MAX_SHOWS);
      await vi.waitFor(() =>
        expect(storage.values.get(STORAGE_KEY)).toEqual({
          noticeShows: SAVED_CLIMB_NOTICE_MAX_SHOWS,
          cardDismissedAt: null,
        }),
      );
    });

    it('counts across launches', async () => {
      storage.values.set(STORAGE_KEY, { noticeShows: 2, cardDismissedAt: null });
      await loadSaveNextSession();

      expect(claimSavedClimbNoticeShow()).toBe(true);
      expect(claimSavedClimbNoticeShow()).toBe(false);
    });

    it('keeps counting in memory when the write fails, and reports it', async () => {
      await loadSaveNextSession();
      storage.failWrites = true;

      expect(claimSavedClimbNoticeShow()).toBe(true);

      expect(getSaveNextSessionSnapshot()?.noticeShows).toBe(1);
      await vi.waitFor(() => expect(reportErrorMock).toHaveBeenCalledTimes(1));
    });
  });

  describe('the card dismissal', () => {
    it('records the dismissal for good, without touching the notice count', async () => {
      storage.values.set(STORAGE_KEY, { noticeShows: 1, cardDismissedAt: null });

      await dismissSavedClimbsCard(500);

      expect(getSaveNextSessionSnapshot()).toEqual({ noticeShows: 1, cardDismissedAt: 500 });
      await vi.waitFor(() => expect(storage.values.get(STORAGE_KEY)).toEqual({ noticeShows: 1, cardDismissedAt: 500 }));
    });

    it('keeps the first dismissal time', async () => {
      await dismissSavedClimbsCard(500);
      await dismissSavedClimbsCard(900);

      expect(getSaveNextSessionSnapshot()?.cardDismissedAt).toBe(500);
    });

    it('still hides the card for this launch when storage cannot be read', async () => {
      storage.failReads = true;

      await dismissSavedClimbsCard(500);

      expect(getSaveNextSessionSnapshot()?.cardDismissedAt).toBe(500);
      expect(reportErrorMock).toHaveBeenCalled();
    });
  });

  it('reports a failed background read and retries on the next ask', async () => {
    storage.failReads = true;
    ensureSaveNextSessionLoaded();
    await vi.waitFor(() => expect(reportErrorMock).toHaveBeenCalledTimes(1));
    expect(getSaveNextSessionSnapshot()).toBeNull();

    storage.failReads = false;
    await expect(loadSaveNextSession()).resolves.toEqual({ noticeShows: 0, cardDismissedAt: null });
  });
});
