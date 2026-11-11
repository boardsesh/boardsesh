import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';

const backend = vi.hoisted(() => ({ request: vi.fn() }));
const storage = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  writes: [] as string[],
  beforeWrite: vi.fn(async (_key: string) => undefined),
}));

const auth = vi.hoisted(() => ({ token: 'token' as string | null }));
vi.mock('../../auth-store', () => ({ getAuthToken: async () => auth.token }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => backend }));
vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => (storage.records.has(key) ? storage.records.get(key) : null),
  setPreference: async (key: string, value: unknown) => {
    await storage.beforeWrite(key);
    storage.writes.push(key);
    storage.records.set(key, value);
  },
  removePreference: async (key: string) => {
    storage.records.delete(key);
  },
  removePreferencesMatching: async (matchesKey: (key: string) => boolean) => {
    for (const key of storage.records.keys()) if (matchesKey(key)) storage.records.delete(key);
  },
}));

import { subscribeSprayLedConfiguration } from '../spray-led-config-events';
import {
  eraseAllSprayWallLedCaches,
  eraseSprayWallLedCache,
  subscribeSprayWallLedServerChange,
  subscribeSprayWallLedUploadOutcome,
  type SprayWallLedUploadOutcome,
} from '../spray-wall-led-cache';
import {
  markSprayWallLedSaveStarted,
  prepareSprayWallLedRead,
  queueSprayWallLedUpload,
  recheckSprayWallLedAccess,
  resetSprayWallLedSyncForTests,
} from '../spray-wall-led-sync';

const WALL = 'wall-one';
const SETTINGS_KEY = 'sprayWallLedSettings:wall-one';
const LAYOUT_KEY = 'sprayWallTnutLayout:wall-one';
const UNSENT_SETTINGS = 'sprayWallLedUnsent:settings:wall-one';
const UNSENT_LAYOUT = 'sprayWallLedUnsent:layout:wall-one';

const local = { version: 1, enabled: true, controller: { type: 'wled', url: 'http://wled.local' } };

function layout(photoKey = 'photo-key'): TnutLayout {
  return {
    version: 1,
    pattern: 'custom',
    rows: 1,
    columns: 1,
    firstRowOffset: false,
    corners: structuredClone(DEFAULT_TNUT_CORNERS),
    holes: [{ x: 0.5, y: 0.5 }],
    photoKey,
  };
}

/** The server's row: jsonb key order differs from what the reader builds. */
const rowFor = (overrides: Record<string, unknown> = {}) => ({
  boardUuid: WALL,
  controllerType: 'wled',
  controllerUrl: 'http://wled.local',
  enabled: true,
  layout: null as unknown,
  updatedAt: '2026-11-09T00:00:00.000Z',
  ...overrides,
});
const answering = (viewerCanEdit: boolean, setup: ReturnType<typeof rowFor> | null) => ({
  sprayWallLedSetup: { viewerCanEdit, setup },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Long enough for the on-demand HTTP client import and the upload chain behind it. */
const settle = async () => {
  for (let round = 0; round < 4; round += 1) {
    await vi.dynamicImportSettled();
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const operations = () =>
  backend.request.mock.calls.map(([document]) => String(document).match(/(query|mutation) (\w+)/)?.[2]);
const saves = () =>
  backend.request.mock.calls
    .filter(([document]) => String(document).includes('mutation'))
    .map(([, variables]) => (variables as { input: Record<string, unknown> }).input);

let configurationEvents: string[];
let serverChanges: string[];
let uploadOutcomes: SprayWallLedUploadOutcome[];
const unsubscribes: Array<() => void> = [];

beforeEach(() => {
  auth.token = 'token';
  backend.request.mockReset().mockResolvedValue(answering(true, null));
  storage.records.clear();
  storage.writes.length = 0;
  storage.beforeWrite.mockReset().mockResolvedValue(undefined);
  resetSprayWallLedSyncForTests();
  configurationEvents = [];
  serverChanges = [];
  uploadOutcomes = [];
  unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
  unsubscribes.push(
    subscribeSprayLedConfiguration((wallUuid) => configurationEvents.push(wallUuid)),
    subscribeSprayWallLedServerChange((wallUuid) => serverChanges.push(wallUuid)),
    subscribeSprayWallLedUploadOutcome((_wall, outcome) => uploadOutcomes.push(outcome)),
  );
});

describe('reading a wall’s LED setup', () => {
  it('keeps the copy when a routine withdrawal turns out not to be one', async () => {
    storage.records.set(SETTINGS_KEY, local);
    backend.request.mockResolvedValue(answering(false, rowFor()));
    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    backend.request.mockClear();
    recheckSprayWallLedAccess(WALL);
    await settle();
    expect(backend.request).toHaveBeenCalledTimes(1);
    expect(storage.records.get(SETTINGS_KEY)).toEqual(local);
  });

  it('erases the copy once the server says access has gone', async () => {
    storage.records.set(SETTINGS_KEY, local);
    backend.request.mockResolvedValue({ sprayWallLedSetup: null });
    recheckSprayWallLedAccess(WALL);
    await settle();
    expect(storage.records.has(SETTINGS_KEY)).toBe(false);
  });

  it('asks the server nothing while signed out', async () => {
    auth.token = null;
    await prepareSprayWallLedRead(WALL, 'settings');
    expect(backend.request).not.toHaveBeenCalled();
  });

  it('waits for the server when this phone has no copy, and stores what it says', async () => {
    const answer = deferred<unknown>();
    backend.request.mockReturnValueOnce(answer.promise);
    let done = false;
    const reading = prepareSprayWallLedRead(WALL, 'settings').then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    expect(operations()).toEqual(['GetSprayWallLedSetup']);

    answer.resolve(answering(false, rowFor({ layout: layout() })));
    await reading;
    expect(storage.records.get(SETTINGS_KEY)).toEqual(local);
    expect(storage.records.get(LAYOUT_KEY)).toEqual(layout());
    expect(configurationEvents).toEqual([WALL]);
    expect(serverChanges).toEqual([WALL]);
  });

  it('answers from the copy at once and corrects it from the server behind that', async () => {
    storage.records.set(SETTINGS_KEY, { ...local, enabled: false });
    const answer = deferred<unknown>();
    backend.request.mockReturnValueOnce(answer.promise);

    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    expect(operations()).toEqual(['GetSprayWallLedSetup']);
    expect(storage.records.get(SETTINGS_KEY)).toEqual({ ...local, enabled: false });

    answer.resolve(answering(false, rowFor()));
    await settle();
    expect(storage.records.get(SETTINGS_KEY)).toEqual(local);
    expect(configurationEvents).toEqual([WALL]);
  });

  it('keeps a wall already set up working with no internet', async () => {
    storage.records.set(SETTINGS_KEY, local);
    storage.records.set(LAYOUT_KEY, layout());
    backend.request.mockRejectedValue(new Error('Network request failed'));

    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    expect(storage.records.get(SETTINGS_KEY)).toEqual(local);
    expect(storage.records.get(LAYOUT_KEY)).toEqual(layout());
    expect(configurationEvents).toEqual([]);
  });

  it('never fires the relight event for a refresh that changes nothing', async () => {
    storage.records.set(SETTINGS_KEY, local);
    storage.records.set(LAYOUT_KEY, layout());
    // The server's jsonb column returns object keys in its own order.
    const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(layout()))).reverse());
    backend.request.mockResolvedValue(answering(false, rowFor({ layout: reordered })));

    await prepareSprayWallLedRead(WALL, 'layout');
    await settle();
    expect(configurationEvents).toEqual([]);
    expect(storage.writes).toEqual([]);
  });

  it('does not treat a server row with a blank, disabled setup as a change for a phone with no copy', async () => {
    backend.request.mockResolvedValue(answering(false, rowFor({ controllerUrl: '', enabled: false })));
    await prepareSprayWallLedRead(WALL, 'settings');
    expect(configurationEvents).toEqual([]);
    expect(storage.records.has(SETTINGS_KEY)).toBe(false);
  });

  it('sends one request for every reader of a wall, and keeps the answer fresh', async () => {
    await Promise.all([prepareSprayWallLedRead(WALL, 'settings'), prepareSprayWallLedRead(WALL, 'layout')]);
    await prepareSprayWallLedRead(WALL, 'settings');
    expect(operations()).toEqual(['GetSprayWallLedSetup']);
  });

  it('tries a failed read again only after the short window, not on every press', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      backend.request.mockRejectedValue(new Error('offline'));
      await prepareSprayWallLedRead(WALL, 'settings');
      await prepareSprayWallLedRead(WALL, 'settings');
      expect(operations()).toHaveLength(1);
      vi.advanceTimersByTime(31_000);
      await prepareSprayWallLedRead(WALL, 'settings');
      expect(operations()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an address the server sends that is not on a local network as no address', async () => {
    backend.request.mockResolvedValue(answering(false, rowFor({ controllerUrl: 'http://example.com' })));
    await prepareSprayWallLedRead(WALL, 'settings');
    expect(storage.records.get(SETTINGS_KEY)).toMatchObject({ controller: { url: '' } });
  });

  it('drops the copy when the server says this viewer can no longer read the wall', async () => {
    storage.records.set(SETTINGS_KEY, local);
    storage.records.set(LAYOUT_KEY, layout());
    backend.request.mockResolvedValue({ sprayWallLedSetup: null });
    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    expect(storage.records.has(SETTINGS_KEY)).toBe(false);
    expect(storage.records.has(LAYOUT_KEY)).toBe(false);
    expect(configurationEvents).toEqual([WALL]);
  });

  it('clears a stale copy for a non-owner when the wall has no setup any more', async () => {
    storage.records.set(SETTINGS_KEY, local);
    backend.request.mockResolvedValue(answering(false, null));
    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    expect(storage.records.get(SETTINGS_KEY)).toMatchObject({ enabled: false, controller: { url: '' } });
    expect(configurationEvents).toEqual([WALL]);
  });
});

describe('one-time adoption of a phone-only setup', () => {
  it('uploads a local setup when the wall has no row and this viewer owns it', async () => {
    storage.records.set(SETTINGS_KEY, local);
    storage.records.set(LAYOUT_KEY, layout());
    backend.request
      .mockResolvedValueOnce(answering(true, null))
      .mockResolvedValueOnce({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });

    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();

    expect(operations()).toEqual(['GetSprayWallLedSetup', 'SaveSprayWallLedSetup']);
    expect(saves()[0]).toEqual({
      boardUuid: WALL,
      controllerType: 'wled',
      controllerUrl: 'http://wled.local',
      enabled: true,
      layout: layout(),
    });
    expect(storage.records.has(UNSENT_SETTINGS)).toBe(false);
    expect(storage.records.has(UNSENT_LAYOUT)).toBe(false);
    expect(configurationEvents).toEqual([]);
  });

  it('uploads nothing for a viewer who does not own the wall', async () => {
    storage.records.set(LAYOUT_KEY, layout());
    backend.request.mockResolvedValue(answering(false, null));
    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    expect(operations()).toEqual(['GetSprayWallLedSetup']);
  });

  it('adopts nothing when there is no local setup', async () => {
    backend.request.mockResolvedValue(answering(true, null));
    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    expect(operations()).toEqual(['GetSprayWallLedSetup']);
  });

  it('leaves a non-local address behind instead of having the server refuse the whole upload', async () => {
    storage.records.set(SETTINGS_KEY, { ...local, controller: { type: 'wled', url: 'http://example.com' } });
    storage.records.set(LAYOUT_KEY, layout());
    backend.request
      .mockResolvedValueOnce(answering(true, null))
      .mockResolvedValueOnce({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });
    await prepareSprayWallLedRead(WALL, 'settings');
    await settle();
    expect(saves()[0]).toMatchObject({ controllerUrl: '', layout: layout() });
  });
});

describe('saving', () => {
  async function saveLocally(field: 'settings' | 'layout', value: unknown) {
    await markSprayWallLedSaveStarted(WALL, field, async () => {
      storage.records.set(field === 'settings' ? SETTINGS_KEY : LAYOUT_KEY, value);
    });
    queueSprayWallLedUpload(WALL, field);
  }

  it('keeps a layout saved while a refresh is writing settings', async () => {
    storage.records.set(SETTINGS_KEY, { ...local, enabled: false });
    storage.records.set(LAYOUT_KEY, layout('old-local'));
    const settingsWrite = deferred<void>();
    storage.beforeWrite.mockImplementation(async (key: string) => {
      if (key === SETTINGS_KEY) await settingsWrite.promise;
    });
    backend.request.mockImplementation(async (document: unknown) =>
      String(document).includes('mutation')
        ? Promise.reject(new Error('offline'))
        : answering(true, rowFor({ layout: layout('old-server') })),
    );
    await prepareSprayWallLedRead(WALL, 'settings');
    await vi.waitFor(() => expect(storage.beforeWrite).toHaveBeenCalledWith(SETTINGS_KEY));
    const saving = markSprayWallLedSaveStarted(WALL, 'layout', async () => {
      storage.records.set(LAYOUT_KEY, layout('new-local'));
    });
    settingsWrite.resolve();
    await saving;
    await settle();
    expect(storage.records.get(LAYOUT_KEY)).toEqual(layout('new-local'));
    expect(storage.records.get(UNSENT_LAYOUT)).toBe(true);
  });

  it('preserves a newer unsent save when an older upload finishes during its disk write', async () => {
    const firstUpload = deferred<unknown>();
    backend.request.mockReturnValueOnce(firstUpload.promise).mockRejectedValue(new Error('offline'));
    await saveLocally('layout', layout('first'));
    await settle();
    const diskWrite = deferred<void>();
    const saving = markSprayWallLedSaveStarted(WALL, 'layout', async () => {
      await diskWrite.promise;
      storage.records.set(LAYOUT_KEY, layout('newest'));
    });
    firstUpload.resolve({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });
    await settle();
    expect(storage.records.get(UNSENT_LAYOUT)).toBe(true);
    diskWrite.resolve();
    await saving;
    queueSprayWallLedUpload(WALL, 'layout');
    await settle();
    expect(storage.records.get(UNSENT_LAYOUT)).toBe(true);
    resetSprayWallLedSyncForTests();
    backend.request.mockImplementation(async (document: unknown) =>
      String(document).includes('mutation')
        ? Promise.reject(new Error('offline'))
        : answering(true, rowFor({ layout: layout('server-still-old') })),
    );
    await prepareSprayWallLedRead(WALL, 'layout');
    await settle();
    expect(storage.records.get(LAYOUT_KEY)).toEqual(layout('newest'));
    expect(storage.records.get(UNSENT_LAYOUT)).toBe(true);
  });

  it('uploads and clears the unsent mark', async () => {
    backend.request.mockResolvedValue({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });
    await saveLocally('settings', local);
    expect(storage.records.get(UNSENT_SETTINGS)).toBe(true);
    await settle();
    expect(saves()).toEqual([
      { boardUuid: WALL, controllerType: 'wled', controllerUrl: 'http://wled.local', enabled: true },
    ]);
    expect(storage.records.has(UNSENT_SETTINGS)).toBe(false);
    expect(uploadOutcomes).toEqual(['uploaded']);
  });

  it('keeps layout and settings separate: a layout save sends no settings', async () => {
    backend.request.mockResolvedValue({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });
    await saveLocally('layout', layout());
    await settle();
    expect(Object.keys(saves()[0])).toEqual(['boardUuid', 'layout']);
  });

  it('coalesces step saves: one upload in flight, then only the newest', async () => {
    const firstUpload = deferred<unknown>();
    backend.request
      .mockReturnValueOnce(firstUpload.promise)
      .mockResolvedValue({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });

    await saveLocally('layout', layout('step-1'));
    await settle();
    await saveLocally('layout', layout('step-2'));
    await saveLocally('layout', layout('step-3'));
    await saveLocally('settings', local);
    await settle();
    expect(backend.request).toHaveBeenCalledTimes(1);

    firstUpload.resolve({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });
    await settle();

    expect(saves()).toHaveLength(2);
    expect(saves()[0].layout).toEqual(layout('step-1'));
    expect(saves()[1]).toMatchObject({ layout: layout('step-3'), enabled: true });
  });

  it('does not let a read started before an upload overwrite what the upload just sent', async () => {
    const answer = deferred<unknown>();
    backend.request.mockReturnValueOnce(answer.promise);
    storage.records.set(SETTINGS_KEY, { ...local, enabled: false });
    await prepareSprayWallLedRead(WALL, 'settings');

    backend.request.mockResolvedValueOnce({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });
    await saveLocally('settings', local);
    await settle();

    answer.resolve(answering(true, rowFor({ enabled: false })));
    await settle();
    expect(storage.records.get(SETTINGS_KEY)).toEqual(local);
    expect(configurationEvents).toEqual([]);
  });

  it('keeps an unsent save over the server copy, and surfaces the failure', async () => {
    storage.records.set(LAYOUT_KEY, layout('mine'));
    await markSprayWallLedSaveStarted(WALL, 'layout');
    backend.request.mockRejectedValueOnce(new Error('offline'));
    queueSprayWallLedUpload(WALL, 'layout');
    await settle();
    expect(uploadOutcomes).toEqual(['failed']);
    expect(storage.records.get(UNSENT_LAYOUT)).toBe(true);

    // The next launch: nothing in memory, the unsent mark still on disk.
    resetSprayWallLedSyncForTests();
    backend.request.mockImplementation(async (document: unknown) =>
      String(document).includes('mutation')
        ? { saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } }
        : answering(true, rowFor({ layout: layout('theirs') })),
    );
    await prepareSprayWallLedRead(WALL, 'layout');
    await settle();

    expect(storage.records.get(LAYOUT_KEY)).toEqual(layout('mine'));
    expect(saves()).toHaveLength(2);
    expect(saves()[1].layout).toEqual(layout('mine'));
    expect(storage.records.has(UNSENT_LAYOUT)).toBe(false);
    expect(uploadOutcomes).toEqual(['failed', 'uploaded']);
  });

  it('stops holding a save the server will never accept', async () => {
    storage.records.set(SETTINGS_KEY, local);
    await markSprayWallLedSaveStarted(WALL, 'settings');
    backend.request.mockRejectedValueOnce({
      response: { errors: [{ message: 'no', extensions: { code: 'SPRAY_WALL_LED_EDIT_DENIED' } }] },
    });
    queueSprayWallLedUpload(WALL, 'settings');
    await settle();
    expect(storage.records.has(UNSENT_SETTINGS)).toBe(false);
    expect(uploadOutcomes).toEqual(['failed']);
  });
});

describe('forgetting a wall', () => {
  it('drops the copy, the unsent marks and any answer still on the wire when access is withdrawn', async () => {
    storage.records.set(LAYOUT_KEY, layout());
    storage.records.set(SETTINGS_KEY, local);
    await markSprayWallLedSaveStarted(WALL, 'layout');

    const answer = deferred<unknown>();
    backend.request.mockReturnValueOnce(answer.promise);
    await prepareSprayWallLedRead(WALL, 'layout');

    await eraseSprayWallLedCache(WALL);
    answer.resolve(answering(false, rowFor({ layout: layout('late') })));
    await settle();

    expect(storage.records.size).toBe(0);
    expect(configurationEvents).toEqual([]);
  });

  it('erases every wall at sign-out and stops an upload mid-flight from marking anything', async () => {
    storage.records.set(SETTINGS_KEY, local);
    storage.records.set('sprayWallTnutLayout:wall-two', layout());
    storage.records.set('sprayWallLedUnsent:settings:wall-two', true);
    storage.records.set('someOtherPreference', 'kept');

    const upload = deferred<unknown>();
    backend.request.mockReturnValueOnce(upload.promise);
    queueSprayWallLedUpload(WALL, 'settings');
    await settle();

    await eraseAllSprayWallLedCaches();
    upload.resolve({ saveSprayWallLedSetup: { boardUuid: WALL, updatedAt: 'now' } });
    await settle();

    expect([...storage.records.keys()]).toEqual(['someOtherPreference']);
    expect(uploadOutcomes).toEqual([]);
  });
});

it('sends nothing for the dev story wall, which is not a real wall', async () => {
  const story = 'dev-story-spray-led';
  await prepareSprayWallLedRead(story, 'settings');
  await markSprayWallLedSaveStarted(story, 'settings');
  queueSprayWallLedUpload(story, 'settings');
  await settle();
  expect(backend.request).not.toHaveBeenCalled();
  expect(storage.records.size).toBe(0);
});
