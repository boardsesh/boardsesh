import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDataExportDownloadRequest } from '../user-data-export-action';

const mocks = vi.hoisted(() => {
  const directories = new Set<string>();
  const files = new Map<string, number>();
  const createFailures = new Map<string, number>();
  const deleteFailures = new Map<string, number>();
  const appState = { currentState: 'active' };
  const platform = { OS: 'ios' };
  const stateListeners = new Set<(state: string) => void>();
  const generationListeners = new Set<(generation: number) => void>();
  const identity = { generation: 1, nextOperation: 0 };
  function pathOf(parts: (string | { uri: string })[]): string {
    return parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
  }
  class MockDirectory {
    readonly uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = pathOf(parts);
    }
    get exists(): boolean {
      return directories.has(this.uri);
    }
    create(): void {
      const remainingFailures = createFailures.get(this.uri) ?? 0;
      if (remainingFailures > 0) {
        createFailures.set(this.uri, remainingFailures - 1);
        throw new Error('Filesystem creation unavailable');
      }
      directories.add(this.uri);
    }
    delete(): void {
      const remainingFailures = deleteFailures.get(this.uri) ?? 0;
      if (remainingFailures > 0) {
        deleteFailures.set(this.uri, remainingFailures - 1);
        throw new Error('Filesystem deletion unavailable');
      }
      for (const directory of directories) {
        if (directory === this.uri || directory.startsWith(`${this.uri}/`)) directories.delete(directory);
      }
      for (const fileUri of files.keys()) {
        if (fileUri.startsWith(`${this.uri}/`)) files.delete(fileUri);
      }
    }
  }
  class MockFile {
    readonly uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = pathOf(parts);
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    get size(): number {
      return files.get(this.uri) ?? 0;
    }
    static createDownloadTask = vi.fn(
      (_url: string, destination: MockFile, options: { signal: AbortSignal; sessionType: string }) => {
        const task = { downloadAsync: () => download(destination, options.signal), release: vi.fn() };
        downloadTasks.push(task);
        return task;
      },
    );
  }
  const download = vi.fn<(destination: MockFile, signal: AbortSignal) => Promise<MockFile | null>>();
  const downloadTasks: { downloadAsync: () => Promise<MockFile | null>; release: ReturnType<typeof vi.fn> }[] = [];
  return {
    directories,
    files,
    createFailures,
    deleteFailures,
    appState,
    platform,
    stateListeners,
    generationListeners,
    identity,
    MockDirectory,
    MockFile,
    download,
    downloadTasks,
    isAvailableAsync: vi.fn<() => Promise<boolean>>(),
    shareAsync: vi.fn<(uri: string, options: { mimeType: string; UTI: string }) => Promise<void>>(),
    reportError: vi.fn(),
  };
});
vi.mock('expo-file-system', () => ({
  Directory: mocks.MockDirectory,
  File: mocks.MockFile,
  Paths: { cache: 'file:///cache' },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `operation-${++mocks.identity.nextOperation}` }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: mocks.isAvailableAsync, shareAsync: mocks.shareAsync }));
vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: {
    get currentState() {
      return mocks.appState.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.stateListeners.add(listener);
      return { remove: () => mocks.stateListeners.delete(listener) };
    },
  },
}));
vi.mock('../auth-store', () => ({
  subscribeAuthCredentialGenerationChanges: (listener: (generation: number) => void) => {
    mocks.generationListeners.add(listener);
    return () => mocks.generationListeners.delete(listener);
  },
}));
vi.mock('../error-reporting', () => ({ reportError: mocks.reportError }));

const CACHE_DIRECTORY = 'file:///cache/boardsesh-user-data-exports';
const EXPORT_FILENAME = 'boardsesh-tension-2026-W40-boardsesh.json';
let nativeDownloads: typeof import('../user-data-export-download');
let browserDownloads: typeof import('../user-data-export-download.web');
let retention: typeof import('../../offline/download-task-retention');
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function exportRequest(overrides: Partial<UserDataExportDownloadRequest> = {}): UserDataExportDownloadRequest {
  const generation = mocks.identity.generation;
  return {
    url: 'https://private.test/history.json?signature=short-lived',
    filename: EXPORT_FILENAME,
    credentialGeneration: generation,
    isCurrent: () => mocks.identity.generation === generation,
    signal: new AbortController().signal,
    ...overrides,
  };
}
function writeDownloadedFile(destination: InstanceType<typeof mocks.MockFile>, bytes = 123): void {
  // A late native completion can recreate files after cancellation cleanup.
  mocks.directories.add(destination.uri.slice(0, destination.uri.lastIndexOf('/')));
  mocks.files.set(destination.uri, bytes);
}
function changeAppState(state: string): void {
  mocks.appState.currentState = state;
  for (const listener of mocks.stateListeners) listener(state);
}
function changeGeneration(generation: number): void {
  mocks.identity.generation = generation;
  for (const listener of mocks.generationListeners) listener(generation);
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  mocks.directories.clear();
  mocks.files.clear();
  mocks.createFailures.clear();
  mocks.deleteFailures.clear();
  mocks.stateListeners.clear();
  mocks.generationListeners.clear();
  mocks.downloadTasks.length = 0;
  mocks.identity.generation = 1;
  mocks.identity.nextOperation = 0;
  mocks.appState.currentState = 'active';
  mocks.platform.OS = 'ios';
  mocks.download.mockReset().mockImplementation(async (destination) => {
    writeDownloadedFile(destination);
    return destination;
  });
  mocks.isAvailableAsync.mockReset().mockResolvedValue(true);
  mocks.shareAsync.mockReset().mockResolvedValue(undefined);
  nativeDownloads = await import('../user-data-export-download');
  browserDownloads = await import('../user-data-export-download.web');
  retention = await import('../../offline/download-task-retention');
});
afterEach(() => {
  retention.clearRetainedDownloadTasks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('native export download and sharing', () => {
  it('shares a named local JSON file, then cleans it while retaining the native task safely', async () => {
    const shareStarted = deferred<void>();
    const dismissShare = deferred<void>();
    mocks.shareAsync.mockImplementation(async () => {
      shareStarted.resolve();
      await dismissShare.promise;
    });
    const sharing = nativeDownloads.openUserDataExportDownload(exportRequest());
    await shareStarted.promise;
    const localUri = `${CACHE_DIRECTORY}/operation-1/${EXPORT_FILENAME}`;
    expect(mocks.MockFile.createDownloadTask).toHaveBeenCalledWith(
      'https://private.test/history.json?signature=short-lived',
      expect.objectContaining({ uri: localUri }),
      { sessionType: 'foreground', signal: expect.any(AbortSignal) },
    );
    expect(mocks.shareAsync).toHaveBeenCalledWith(localUri, { mimeType: 'application/json', UTI: 'public.json' });
    expect(mocks.files.has(localUri)).toBe(true);
    expect(localUri).not.toContain('signature');
    const task = mocks.downloadTasks[0];
    expect(retention.isDownloadTaskRetained(task)).toBe(true);
    dismissShare.resolve();
    await expect(sharing).resolves.toBeUndefined();
    expect(mocks.files.size).toBe(0);
    await vi.advanceTimersByTimeAsync(retention.DOWNLOAD_TASK_RETENTION_MS - 1);
    expect(retention.isDownloadTaskRetained(task)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(retention.isDownloadTaskRetained(task)).toBe(false);
    expect(task.release).not.toHaveBeenCalled();
  });
  it('treats a cancelled share sheet as dismissal and removes its cached file', async () => {
    mocks.shareAsync.mockResolvedValue(undefined);
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).resolves.toBeUndefined();
    expect(mocks.shareAsync).toHaveBeenCalledOnce();
    expect(mocks.files.size).toBe(0);
  });
  it.each(['download', 'share'] as const)(
    'sanitizes raw %s failures without preserving a private URL',
    async (phase) => {
      const rawFailure = new Error('Native failure: https://private.test/history.json?signature=private-secret');
      if (phase === 'download')
        mocks.download.mockImplementation(async (destination) => {
          writeDownloadedFile(destination, 12);
          throw rawFailure;
        });
      else mocks.shareAsync.mockRejectedValue(rawFailure);
      const failure: unknown = await nativeDownloads
        .openUserDataExportDownload(exportRequest())
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ reason: phase === 'download' ? 'download_failed' : 'share_failed' });
      expect(failure).not.toBe(rawFailure);
      expect(String(failure)).not.toContain('private-secret');
      expect(failure).not.toHaveProperty('cause');
      expect(mocks.files.size).toBe(0);
      expect(mocks.reportError).not.toHaveBeenCalled();
      const task = mocks.downloadTasks[0];
      expect(retention.isDownloadTaskRetained(task)).toBe(true);
      expect(task.release).not.toHaveBeenCalled();
    },
  );
  it.each([false, new Error('Missing native sharing module')])(
    'fails before downloading when sharing is unavailable',
    async (availability) => {
      if (availability instanceof Error) mocks.isAvailableAsync.mockRejectedValue(availability);
      else mocks.isAvailableAsync.mockResolvedValue(availability);
      await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).rejects.toMatchObject({
        reason: 'sharing_unavailable',
      });
      expect(mocks.download).not.toHaveBeenCalled();
      expect(mocks.shareAsync).not.toHaveBeenCalled();
      expect(mocks.files.size).toBe(0);
    },
  );
  it('preserves known export errors from the sharing availability check', async () => {
    const { UserDataExportActionError } = await import('../user-data-export-action');
    const failure = new UserDataExportActionError('cleanup_failed');
    mocks.isAvailableAsync.mockRejectedValue(failure);
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).rejects.toBe(failure);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.shareAsync).not.toHaveBeenCalled();
  });
  it.each(['null', 'empty', 'missing'] as const)('does not share a %s download result', async (result) => {
    mocks.download.mockImplementation(async (destination) => {
      if (result === 'null') return null;
      if (result === 'empty') writeDownloadedFile(destination, 0);
      return destination;
    });
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).rejects.toMatchObject({
      reason: 'download_failed',
    });
    expect(mocks.shareAsync).not.toHaveBeenCalled();
    expect(mocks.files.size).toBe(0);
  });
  it.each([
    'http://private.test/history.json',
    'file:///tmp/export.json',
    'javascript:alert(1)',
    'https://user:secret@private.test/export',
    'not a URL',
  ])('rejects an unsafe download URL: %s', async (url) => {
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest({ url }))).rejects.toMatchObject({
      reason: 'download_failed',
    });
    expect(mocks.MockFile.createDownloadTask).not.toHaveBeenCalled();
  });
  it.each(['../history.json', 'history.txt', '/history.json', 'history.json?signature=private'])(
    'rejects an unsafe filename: %s',
    async (filename) => {
      await expect(nativeDownloads.openUserDataExportDownload(exportRequest({ filename }))).rejects.toMatchObject({
        reason: 'download_failed',
      });
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );
  it('removes previous-process exports before starting a new download', async () => {
    mocks.directories.add(CACHE_DIRECTORY);
    mocks.directories.add(`${CACHE_DIRECTORY}/abandoned`);
    mocks.files.set(`${CACHE_DIRECTORY}/abandoned/private.json`, 12);
    mocks.files.set('file:///cache/unrelated/photo.jpg', 50);
    mocks.download.mockImplementation(async (destination) => {
      expect(mocks.files.has(`${CACHE_DIRECTORY}/abandoned/private.json`)).toBe(false);
      expect(mocks.files.has('file:///cache/unrelated/photo.jpg')).toBe(true);
      writeDownloadedFile(destination);
      return destination;
    });
    const startup = nativeDownloads.initializeUserDataExportDownloads();
    const download = nativeDownloads.openUserDataExportDownload(exportRequest());
    await startup;
    await download;
    expect([...mocks.files.keys()]).toEqual(['file:///cache/unrelated/photo.jpg']);
  });
  it('retries failed startup cleanup before accepting another download', async () => {
    mocks.directories.add(CACHE_DIRECTORY);
    mocks.directories.add(`${CACHE_DIRECTORY}/abandoned`);
    mocks.files.set(`${CACHE_DIRECTORY}/abandoned/private.json`, 12);
    mocks.deleteFailures.set(CACHE_DIRECTORY, 1);
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).rejects.toMatchObject({
      reason: 'cleanup_failed',
    });
    expect(mocks.download).not.toHaveBeenCalled();
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).resolves.toBeUndefined();
    expect(mocks.files.size).toBe(0);
  });
  it('retries initialization after root directory creation fails', async () => {
    mocks.createFailures.set(CACHE_DIRECTORY, 1);
    await expect(nativeDownloads.initializeUserDataExportDownloads()).rejects.toMatchObject({
      reason: 'cleanup_failed',
    });
    expect(mocks.directories.has(CACHE_DIRECTORY)).toBe(false);
    expect(mocks.download).not.toHaveBeenCalled();
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).resolves.toBeUndefined();
    expect(mocks.directories.has(CACHE_DIRECTORY)).toBe(true);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.shareAsync).toHaveBeenCalledOnce();
    expect(mocks.files.size).toBe(0);
  });
  it('aborts while checking sharing availability without starting a transfer', async () => {
    const availability = deferred<boolean>();
    const availabilityStarted = deferred<void>();
    const controller = new AbortController();
    mocks.isAvailableAsync.mockImplementation(() => {
      availabilityStarted.resolve();
      return availability.promise;
    });
    const download = nativeDownloads.openUserDataExportDownload(exportRequest({ signal: controller.signal }));
    await availabilityStarted.promise;
    controller.abort();
    availability.resolve(true);
    await expect(download).rejects.toMatchObject({ reason: 'session_changed' });
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('rejects an already-aborted request before accessing the filesystem', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      nativeDownloads.openUserDataExportDownload(exportRequest({ signal: controller.signal })),
    ).rejects.toMatchObject({ reason: 'session_changed' });
    expect(mocks.directories.size).toBe(0);
    expect(mocks.isAvailableAsync).not.toHaveBeenCalled();
  });
  it('maps native abort rejection to session_changed and removes a partial download', async () => {
    const started = deferred<void>();
    const controller = new AbortController();
    let nativeSignal: AbortSignal | undefined;
    mocks.download.mockImplementation((destination, signal) => {
      nativeSignal = signal;
      writeDownloadedFile(destination, 12);
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Native task cancelled')), { once: true });
      });
    });
    const download = nativeDownloads.openUserDataExportDownload(exportRequest({ signal: controller.signal }));
    await started.promise;
    controller.abort();
    await expect(download).rejects.toMatchObject({ reason: 'session_changed' });
    expect(nativeSignal?.aborted).toBe(true);
    expect(mocks.files.size).toBe(0);
    expect(mocks.shareAsync).not.toHaveBeenCalled();
  });
  it('removes a revoked account file while its share sheet is still active', async () => {
    const shareStarted = deferred<void>();
    const dismissal = deferred<void>();
    mocks.shareAsync.mockImplementation(async () => {
      shareStarted.resolve();
      await dismissal.promise;
    });
    const sharing = nativeDownloads.openUserDataExportDownload(exportRequest());
    await shareStarted.promise;
    expect(mocks.files.size).toBe(1);
    changeGeneration(2);
    expect(mocks.files.size).toBe(0);
    dismissal.resolve();
    await expect(sharing).rejects.toMatchObject({ reason: 'session_changed' });
    expect(mocks.files.size).toBe(0);
    expect(mocks.shareAsync).toHaveBeenCalledOnce();
  });
  it('cleans a late old-account completion without deleting a new account share', async () => {
    const oldTransferStarted = deferred<void>();
    const finishOldTransfer = deferred<void>();
    mocks.download.mockImplementationOnce(async (destination) => {
      writeDownloadedFile(destination, 12);
      oldTransferStarted.resolve();
      await finishOldTransfer.promise;
      writeDownloadedFile(destination);
      return destination;
    });
    const oldDownload = nativeDownloads.openUserDataExportDownload(exportRequest());
    await oldTransferStarted.promise;
    changeGeneration(2);
    const newShareStarted = deferred<void>();
    const finishNewShare = deferred<void>();
    mocks.shareAsync.mockImplementation(async () => {
      newShareStarted.resolve();
      await finishNewShare.promise;
    });
    const newDownload = nativeDownloads.openUserDataExportDownload(exportRequest());
    await newShareStarted.promise;
    const newUri = `${CACHE_DIRECTORY}/operation-2/${EXPORT_FILENAME}`;
    expect(mocks.files.has(newUri)).toBe(true);
    await nativeDownloads.clearUserDataExportDownloads(1);
    expect(mocks.files.has(newUri)).toBe(true);
    finishOldTransfer.resolve();
    await expect(oldDownload).rejects.toMatchObject({ reason: 'session_changed' });
    expect([...mocks.files.keys()]).toEqual([newUri]);
    expect(mocks.shareAsync).toHaveBeenCalledOnce();
    finishNewShare.resolve();
    await newDownload;
    expect(mocks.files.size).toBe(0);
  });
  it('keeps an already-registered generation 2 share intact during generation 1 cleanup', async () => {
    await nativeDownloads.initializeUserDataExportDownloads();
    changeGeneration(2);
    const shareStarted = deferred<void>();
    const dismissShare = deferred<void>();
    mocks.shareAsync.mockImplementation(async () => {
      shareStarted.resolve();
      await dismissShare.promise;
    });
    const sharing = nativeDownloads.openUserDataExportDownload(exportRequest());
    await shareStarted.promise;
    const localUri = `${CACHE_DIRECTORY}/operation-1/${EXPORT_FILENAME}`;
    const nativeSignal = mocks.MockFile.createDownloadTask.mock.calls[0][2].signal;
    await nativeDownloads.clearUserDataExportDownloads(1);
    expect(mocks.files.has(localUri)).toBe(true);
    expect(nativeSignal.aborted).toBe(false);
    dismissShare.resolve();
    await expect(sharing).resolves.toBeUndefined();
    expect(mocks.files.size).toBe(0);
  });
  it('retries failed operation cleanup on foreground and reports only sanitized errors', async () => {
    mocks.deleteFailures.set(`${CACHE_DIRECTORY}/operation-1`, 2);
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).rejects.toMatchObject({
      reason: 'cleanup_failed',
    });
    expect(mocks.files.size).toBe(1);
    changeAppState('active');
    expect(mocks.reportError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cleanup_failed' }));
    expect(mocks.files.size).toBe(1);
    changeAppState('active');
    expect(mocks.files.size).toBe(0);
  });
  it('preserves a download failure and reports failed cleanup without private details', async () => {
    mocks.download.mockImplementation(async (destination) => {
      writeDownloadedFile(destination, 12);
      throw new Error('Download failed: https://private.test/history.json?signature=private-secret');
    });
    mocks.deleteFailures.set(`${CACHE_DIRECTORY}/operation-1`, 1);
    await expect(nativeDownloads.openUserDataExportDownload(exportRequest())).rejects.toMatchObject({
      reason: 'download_failed',
    });
    expect(mocks.reportError).toHaveBeenCalledOnce();
    const reported: unknown = mocks.reportError.mock.calls[0][0];
    expect(reported).toMatchObject({ reason: 'cleanup_failed' });
    expect(String(reported)).not.toContain('private-secret');
    expect(reported).not.toHaveProperty('cause');
    expect(mocks.files.size).toBe(1);
    changeAppState('active');
    expect(mocks.files.size).toBe(0);
  });
});

describe('Android receiver file lifetime', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
  });
  it('keeps files while backgrounded, then gives the receiver 60 active seconds', async () => {
    mocks.shareAsync.mockImplementation(async () => {
      changeAppState('background');
    });
    await nativeDownloads.openUserDataExportDownload(exportRequest());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mocks.files.size).toBe(1);
    changeAppState('active');
    await vi.advanceTimersByTimeAsync(nativeDownloads.USER_DATA_EXPORT_ANDROID_CLEANUP_MS - 1);
    expect(mocks.files.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.files.size).toBe(0);
  });
  it('pauses the grace period while away instead of restarting it on every return', async () => {
    await nativeDownloads.openUserDataExportDownload(exportRequest());
    await vi.advanceTimersByTimeAsync(30_000);
    changeAppState('background');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mocks.files.size).toBe(1);
    changeAppState('active');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.files.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.files.size).toBe(0);
  });
  it('removes a signed-out account file immediately despite the receiver grace period', async () => {
    mocks.shareAsync.mockImplementation(async () => {
      changeAppState('background');
    });
    await nativeDownloads.openUserDataExportDownload(exportRequest());
    expect(mocks.files.size).toBe(1);
    changeGeneration(2);
    await nativeDownloads.clearUserDataExportDownloads(1);
    expect(mocks.files.size).toBe(0);
    changeAppState('active');
    await vi.advanceTimersByTimeAsync(nativeDownloads.USER_DATA_EXPORT_ANDROID_CLEANUP_MS);
    expect(mocks.files.size).toBe(0);
  });
  it('clears an expired account file even when credential storage never advanced its generation', async () => {
    await nativeDownloads.openUserDataExportDownload(exportRequest());
    expect(mocks.files.size).toBe(1);
    await nativeDownloads.clearUserDataExportDownloads(1);
    expect(mocks.files.size).toBe(0);
    expect(mocks.identity.generation).toBe(1);
  });
});

describe('browser export navigation', () => {
  it('navigates the same tab after asynchronous link retrieval without a popup', async () => {
    const assign = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('window', { location: { assign }, open });
    await Promise.resolve();
    const request = exportRequest();
    await expect(browserDownloads.openUserDataExportDownload(request)).resolves.toBeUndefined();
    expect(assign).toHaveBeenCalledWith(request.url);
    expect(open).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.shareAsync).not.toHaveBeenCalled();
  });
  it('sanitizes blocked browser navigation and rejects unsafe links', async () => {
    const assign = vi.fn(() => {
      throw new Error('Blocked signed URL: signature=private');
    });
    vi.stubGlobal('window', { location: { assign } });
    await expect(browserDownloads.openUserDataExportDownload(exportRequest())).rejects.toMatchObject({
      reason: 'browser_failed',
    });
    await expect(
      browserDownloads.openUserDataExportDownload(exportRequest({ url: 'javascript:alert(1)' })),
    ).rejects.toMatchObject({ reason: 'browser_failed' });
    expect(assign).toHaveBeenCalledOnce();
  });
  it('checks ownership before navigation and fails safely without a browser', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    await expect(
      browserDownloads.openUserDataExportDownload(exportRequest({ isCurrent: () => false })),
    ).rejects.toMatchObject({ reason: 'session_changed' });
    expect(assign).not.toHaveBeenCalled();
    vi.stubGlobal('window', undefined);
    await expect(browserDownloads.openUserDataExportDownload(exportRequest())).rejects.toMatchObject({
      reason: 'browser_failed',
    });
  });
});
