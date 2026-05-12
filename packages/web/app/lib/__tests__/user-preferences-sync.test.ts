import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// vi.mock factories are hoisted above any other import — `vi.hoisted` lets
// us share the spy across the factory and the rest of the file.
const { executeGraphQLMock } = vi.hoisted(() => ({
  executeGraphQLMock: vi.fn(),
}));

vi.mock('../graphql/client', () => ({
  executeGraphQL: executeGraphQLMock,
}));

import {
  GET_USER_PREFERENCES,
  SET_USER_PREFERENCE,
  DELETE_USER_PREFERENCE,
} from '../graphql/operations/user-preferences';
import {
  __resetDbPromiseForTests,
  getPreference,
  getPreferenceMeta,
  getSyncQueueSnapshot,
  removePreference,
  setPreference,
} from '../user-preferences-db';
import { SYNCABLE_KEYS, pullInitial, pushQueueFlush } from '../user-preferences-sync';

const AUTH_TOKEN = 'test-token';

const resetIndexedDB = (): void => {
  // fake-indexeddb's documented way to reset between tests: replace the
  // global factory. We also flush our cached connection so the next call
  // re-opens against the fresh factory.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  __resetDbPromiseForTests();
};

beforeEach(() => {
  resetIndexedDB();
  executeGraphQLMock.mockReset();
});

describe('SYNCABLE_KEYS', () => {
  it('includes consent and standard prefs', () => {
    expect(SYNCABLE_KEYS.has('consent')).toBe(true);
    expect(SYNCABLE_KEYS.has('libraryTab')).toBe(true);
    expect(SYNCABLE_KEYS.has('logbookPreferences')).toBe(true);
  });

  it('omits device-specific keys like esp32Connections', () => {
    expect(SYNCABLE_KEYS.has('esp32Connections' as never)).toBe(false);
  });
});

describe('setPreference / sync queue interaction', () => {
  it('enqueues a set op for a syncable key', async () => {
    await setPreference('libraryTab', 'logbook');
    const queue = await getSyncQueueSnapshot();
    expect(queue).toHaveLength(1);
    expect(queue[0].op).toBe('set');
    expect(queue[0].key).toBe('libraryTab');
    if (queue[0].op === 'set') {
      expect(queue[0].value).toBe('logbook');
    }
  });

  it('writes meta when storing a preference', async () => {
    const before = Date.now();
    await setPreference('libraryTab', 'playlists');
    const meta = await getPreferenceMeta('libraryTab');
    expect(meta).not.toBeNull();
    expect(meta!.key).toBe('libraryTab');
    expect(meta!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('does not enqueue ops for non-syncable keys', async () => {
    await setPreference('esp32Connections', []);
    const queue = await getSyncQueueSnapshot();
    expect(queue).toHaveLength(0);
  });

  it('enqueues a delete op when removing a syncable key', async () => {
    await setPreference('libraryTab', 'logbook');
    await removePreference('libraryTab');
    const queue = await getSyncQueueSnapshot();
    // 1 set + 1 delete
    expect(queue).toHaveLength(2);
    expect(queue[1].op).toBe('delete');
    expect(queue[1].key).toBe('libraryTab');
  });

  it('caps the sync queue at 100 entries, dropping the oldest on overflow', async () => {
    // Drive 105 writes through a syncable key. Each setPreference enqueues
    // a 'set' op; once we cross 100, every subsequent write should drop the
    // oldest entry rather than letting the queue grow without bound.
    for (let index = 0; index < 105; index += 1) {
      await setPreference('libraryTab', index % 2 === 0 ? 'logbook' : 'playlists');
    }

    const queue = await getSyncQueueSnapshot();
    expect(queue).toHaveLength(100);

    // Snapshot is oldest-first by autoIncrement key. The first entry in the
    // snapshot must correspond to write #5 (writes 0..4 got trimmed), and
    // the last must correspond to write #104. Each entry's value alternates
    // 'logbook' / 'playlists' by index parity.
    const firstEntry = queue[0];
    const lastEntry = queue[queue.length - 1];
    if (firstEntry.op !== 'set' || lastEntry.op !== 'set') {
      throw new Error('expected only set ops in the queue');
    }
    // index 5 is odd -> 'playlists'; index 104 is even -> 'logbook'.
    expect(firstEntry.value).toBe('playlists');
    expect(lastEntry.value).toBe('logbook');
  });
});

describe('pullInitial', () => {
  it('overwrites local when server is newer', async () => {
    // Seed local with an older value.
    await setPreference('libraryTab', 'playlists');
    const localMeta = await getPreferenceMeta('libraryTab');
    expect(localMeta).not.toBeNull();
    const serverTimestamp = new Date((localMeta!.updatedAt ?? 0) + 60_000).toISOString();

    executeGraphQLMock.mockImplementationOnce(async (doc: unknown) => {
      expect(doc).toBe(GET_USER_PREFERENCES);
      return {
        userPreferences: [{ key: 'libraryTab', value: 'logbook', updatedAt: serverTimestamp }],
      };
    });

    // Drain the orphan-push (no orphans should remain after the server response
    // contains the same key) — return success for any subsequent mutation.
    executeGraphQLMock.mockResolvedValue({});

    await pullInitial(AUTH_TOKEN);

    const updated = await getPreference('libraryTab');
    expect(updated).toBe('logbook');
  });

  it('skips local when local is newer than server', async () => {
    await setPreference('libraryTab', 'logbook');
    const localMeta = await getPreferenceMeta('libraryTab');
    expect(localMeta).not.toBeNull();
    const olderServerTimestamp = new Date((localMeta!.updatedAt ?? 0) - 60_000).toISOString();

    executeGraphQLMock.mockImplementationOnce(async () => ({
      userPreferences: [{ key: 'libraryTab', value: 'playlists', updatedAt: olderServerTimestamp }],
    }));
    executeGraphQLMock.mockResolvedValue({});

    await pullInitial(AUTH_TOKEN);

    const current = await getPreference('libraryTab');
    expect(current).toBe('logbook');
  });

  it('pushes orphan local prefs up to the server', async () => {
    // Seed an orphan: present locally, absent on server. Use an explicit
    // mock that returns an empty server list so the engine pushes the local
    // entry up.
    await setPreference('libraryTab', 'logbook');

    // First call: GET returning empty
    executeGraphQLMock.mockImplementationOnce(async () => ({ userPreferences: [] }));
    // After the orphan is re-saved + queue drains, a SET_USER_PREFERENCE
    // mutation should fire. Capture all subsequent calls for inspection.
    const mutationCalls: unknown[] = [];
    executeGraphQLMock.mockImplementation(async (doc: unknown, vars: unknown) => {
      mutationCalls.push({ doc, vars });
      return { setUserPreference: { key: 'libraryTab', value: 'logbook', updatedAt: new Date().toISOString() } };
    });

    await pullInitial(AUTH_TOKEN);

    // At least one mutation for libraryTab must have been sent.
    const libraryTabSet = mutationCalls.find((call) => {
      const typed = call as { doc: unknown; vars: { input?: { key?: string } } };
      return typed.doc === SET_USER_PREFERENCE && typed.vars?.input?.key === 'libraryTab';
    });
    expect(libraryTabSet).toBeTruthy();
  });

  it('honors a remote deletion: local pref absent from server AFTER a prior pull is removed locally, not re-pushed', async () => {
    // First pull: server has libraryTab=logbook. Establishes lastPulledAt
    // and lands the key locally.
    const firstServerTimestamp = new Date(Date.now() - 60_000).toISOString();
    executeGraphQLMock.mockImplementationOnce(async () => ({
      userPreferences: [{ key: 'libraryTab', value: 'logbook', updatedAt: firstServerTimestamp }],
    }));
    executeGraphQLMock.mockResolvedValue({});
    await pullInitial(AUTH_TOKEN);
    expect(await getPreference('libraryTab')).toBe('logbook');

    // Second pull, much later: server no longer reports libraryTab. We
    // should drop it locally rather than re-push, because the previous
    // pull saw the key — that means another device deleted it.
    executeGraphQLMock.mockReset();
    const mutationCalls: unknown[] = [];
    executeGraphQLMock.mockImplementationOnce(async () => ({ userPreferences: [] }));
    executeGraphQLMock.mockImplementation(async (doc: unknown, vars: unknown) => {
      mutationCalls.push({ doc, vars });
      return {};
    });

    await pullInitial(AUTH_TOKEN);

    expect(await getPreference('libraryTab')).toBeNull();
    // Critically: NO setUserPreference mutation should have been emitted
    // for libraryTab — that would undo the remote delete.
    const libraryTabSet = mutationCalls.find((call) => {
      const typed = call as { doc: unknown; vars: { input?: { key?: string } } };
      return typed.doc === SET_USER_PREFERENCE && typed.vars?.input?.key === 'libraryTab';
    });
    expect(libraryTabSet).toBeUndefined();
  });

  it('still pushes on first-ever pull (no previous lastPulledAt) when local has a pref the server lacks', async () => {
    // Fresh device, no previous pull. Local has a value, server is empty.
    // Without a prior lastPulledAt we can't distinguish "first-install
    // local" from "remote-deleted", so we conservatively push.
    await setPreference('libraryTab', 'logbook');

    const mutationCalls: unknown[] = [];
    executeGraphQLMock.mockImplementationOnce(async () => ({ userPreferences: [] }));
    executeGraphQLMock.mockImplementation(async (doc: unknown, vars: unknown) => {
      mutationCalls.push({ doc, vars });
      return { setUserPreference: { key: 'libraryTab', value: 'logbook', updatedAt: new Date().toISOString() } };
    });

    await pullInitial(AUTH_TOKEN);

    expect(await getPreference('libraryTab')).toBe('logbook');
    const libraryTabSet = mutationCalls.find((call) => {
      const typed = call as { doc: unknown; vars: { input?: { key?: string } } };
      return typed.doc === SET_USER_PREFERENCE && typed.vars?.input?.key === 'libraryTab';
    });
    expect(libraryTabSet).toBeTruthy();
  });

  it('does no work when the auth token is empty', async () => {
    await pullInitial('');
    expect(executeGraphQLMock).not.toHaveBeenCalled();
  });

  it('does not block downstream writes when the GET stalls (5s timeout)', async () => {
    // pullInitial wraps the GET in a 5s withTimeout. Mock executeGraphQL with
    // a promise that never resolves; we expect pullInitial to reject the
    // GET internally, swallow the error, and still return — and importantly,
    // never throw to the caller.
    let getCallResolve: (() => void) | undefined;
    executeGraphQLMock.mockImplementationOnce(
      () =>
        new Promise(() => {
          // Hold the resolver so the await inside pullInitial sits on the
          // unresolved promise. The withTimeout wrapper races against this
          // and rejects after 5s; getCallResolve stays unused on purpose.
          getCallResolve = () => {};
        }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Use vitest fake timers so the test doesn't actually wait 5 real seconds.
    vi.useFakeTimers();
    const pullPromise = pullInitial(AUTH_TOKEN);
    await vi.advanceTimersByTimeAsync(5_500);
    vi.useRealTimers();

    // The pullInitial promise must resolve (not throw) after the timeout fires.
    await expect(pullPromise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pullInitial GET failed'), expect.anything());
    // Reference getCallResolve to silence the unused-variable lint without
    // changing the mock's semantics.
    expect(getCallResolve).toBeDefined();

    warnSpy.mockRestore();
  });
});

describe('pushQueueFlush', () => {
  it('drains every queued entry on successful mutations', async () => {
    await setPreference('libraryTab', 'logbook');
    await setPreference('swipeHint:climbListSeen', true);

    let setCalls = 0;
    executeGraphQLMock.mockImplementation(async () => {
      setCalls += 1;
      return { setUserPreference: { key: 'k', value: null, updatedAt: new Date().toISOString() } };
    });

    await pushQueueFlush(AUTH_TOKEN);

    expect(setCalls).toBe(2);
    const remaining = await getSyncQueueSnapshot();
    expect(remaining).toHaveLength(0);
  });

  it('sends a delete mutation for delete ops', async () => {
    await setPreference('libraryTab', 'logbook');
    await removePreference('libraryTab');

    const calls: { doc: unknown; vars: unknown }[] = [];
    executeGraphQLMock.mockImplementation(async (doc: unknown, vars: unknown) => {
      calls.push({ doc, vars });
      return doc === DELETE_USER_PREFERENCE
        ? { deleteUserPreference: true }
        : { setUserPreference: { key: 'k', value: null, updatedAt: new Date().toISOString() } };
    });

    await pushQueueFlush(AUTH_TOKEN);

    const deleteCall = calls.find((call) => call.doc === DELETE_USER_PREFERENCE);
    expect(deleteCall).toBeTruthy();
    const deleteVars = deleteCall!.vars as { key: string };
    expect(deleteVars.key).toBe('libraryTab');

    const remaining = await getSyncQueueSnapshot();
    expect(remaining).toHaveLength(0);
  });

  it('skips past a failed entry and continues with the rest of the queue', async () => {
    await setPreference('libraryTab', 'logbook');
    await setPreference('swipeHint:climbListSeen', true);
    await setPreference('swipeHint:queueBarSeen', true);

    let call = 0;
    executeGraphQLMock.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('boom');
      return { setUserPreference: { key: 'k', value: null, updatedAt: new Date().toISOString() } };
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await pushQueueFlush(AUTH_TOKEN);

    // All three are tried (no longer blocks on the first failure).
    // The failed entry stays in the queue with attempts incremented to 1;
    // the two successful entries are deleted.
    expect(call).toBe(3);
    const remaining = await getSyncQueueSnapshot();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.key).toBe('swipeHint:climbListSeen');
    expect(remaining[0]!.attempts).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('drops a poison entry after MAX_QUEUE_ENTRY_ATTEMPTS (5) failures', async () => {
    await setPreference('libraryTab', 'logbook');
    executeGraphQLMock.mockImplementation(async () => {
      throw new Error('always-fails');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 4 flushes: attempts go 0 → 1 → 2 → 3 → 4 — entry still queued each time.
    for (let attemptRound = 0; attemptRound < 4; attemptRound += 1) {
      await pushQueueFlush(AUTH_TOKEN);
      const remaining = await getSyncQueueSnapshot();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.attempts).toBe(attemptRound + 1);
    }

    // 5th flush: attempts hits 5 → entry is dropped with a dead-letter warning.
    await pushQueueFlush(AUTH_TOKEN);
    const remaining = await getSyncQueueSnapshot();
    expect(remaining).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropping poison queue entry'), 'set', 'libraryTab');
    warnSpy.mockRestore();
  });

  it('no-ops without an auth token', async () => {
    await setPreference('libraryTab', 'logbook');
    await pushQueueFlush('');
    expect(executeGraphQLMock).not.toHaveBeenCalled();
    const remaining = await getSyncQueueSnapshot();
    expect(remaining).toHaveLength(1);
  });
});
