import { AppState, Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { retainDownloadTask, releaseDownloadTaskAfterNativeCompletion } from '../offline/download-task-retention';
import { subscribeAuthCredentialGenerationChanges } from './auth-store';
import { reportError } from './error-reporting';
import {
  requireCurrentExport,
  UserDataExportActionError,
  type UserDataExportDownloadRequest,
} from './user-data-export-action';
import { isUserDataExportDownloadUrl } from './user-data-export-download-url';

export const USER_DATA_EXPORT_ANDROID_CLEANUP_MS = 60_000;

type ExportOperation = {
  directory: Directory;
  credentialGeneration: number;
  controller: AbortController;
  downloading: boolean;
  sharing: boolean;
  removeRequested: boolean;
  activeCleanupStartedAt: number | null;
  activeCleanupRemainingMs: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

const operations = new Set<ExportOperation>();
let initialization: Promise<void> | null = null;
let lifecycleSubscribed = false;

function exportDirectory(): Directory {
  return new Directory(Paths.cache, 'boardsesh-user-data-exports');
}

function cancelCleanupTimer(operation: ExportOperation): void {
  if (operation.cleanupTimer !== null) clearTimeout(operation.cleanupTimer);
  operation.cleanupTimer = null;
}

function removeOperation(operation: ExportOperation): boolean {
  operation.removeRequested = true;
  cancelCleanupTimer(operation);
  try {
    if (operation.directory.exists) operation.directory.delete();
    // An aborted native download can still finish its last disk write. Keep its
    // directory registered until the promise settles and remove it again then.
    if (!operation.downloading && !operation.sharing) operations.delete(operation);
    return true;
  } catch {
    return false;
  }
}

function reportCleanupFailure(): void {
  reportError(new UserDataExportActionError('cleanup_failed'));
}

function scheduleAndroidCleanup(operation: ExportOperation): void {
  cancelCleanupTimer(operation);
  if (AppState.currentState !== 'active') {
    return;
  }
  operation.activeCleanupStartedAt ??= Date.now();
  const remaining = Math.max(0, operation.activeCleanupRemainingMs - (Date.now() - operation.activeCleanupStartedAt));
  operation.cleanupTimer = setTimeout(() => {
    operation.cleanupTimer = null;
    if (AppState.currentState !== 'active') {
      return;
    }
    if (!removeOperation(operation)) reportCleanupFailure();
  }, remaining);
}

function subscribeLifecycle(): void {
  if (lifecycleSubscribed) return;
  lifecycleSubscribed = true;
  // Both subscriptions intentionally live for this module's lifetime.
  subscribeAuthCredentialGenerationChanges((generation) => {
    for (const operation of operations) {
      if (operation.credentialGeneration >= generation) continue;
      operation.controller.abort();
      if (!removeOperation(operation)) reportCleanupFailure();
    }
  });
  AppState.addEventListener('change', (state) => {
    for (const operation of operations) {
      if (state !== 'active') {
        cancelCleanupTimer(operation);
        if (operation.activeCleanupStartedAt !== null) {
          operation.activeCleanupRemainingMs = Math.max(
            0,
            operation.activeCleanupRemainingMs - (Date.now() - operation.activeCleanupStartedAt),
          );
        }
        operation.activeCleanupStartedAt = null;
      } else if (operation.removeRequested) {
        if (!removeOperation(operation)) reportCleanupFailure();
      } else if (!operation.downloading && !operation.sharing) {
        scheduleAndroidCleanup(operation);
      }
    }
    if (state === 'active' && initialization === null) {
      void initializeUserDataExportDownloads().catch(reportCleanupFailure);
    }
  });
}

/** Sweep a previous process's private files before any new operation creates one. */
export function initializeUserDataExportDownloads(): Promise<void> {
  subscribeLifecycle();
  initialization ??= Promise.resolve().then(() => {
    try {
      const directory = exportDirectory();
      if (directory.exists) directory.delete();
      directory.create({ intermediates: true });
    } catch {
      initialization = null;
      throw new UserDataExportActionError('cleanup_failed');
    }
  });
  return initialization;
}

/** Snapshot operation ownership before awaiting, so later logins keep their files. */
export async function clearUserDataExportDownloads(departingGeneration: number): Promise<void> {
  const previousOperations = [...operations].filter(
    (operation) => operation.credentialGeneration <= departingGeneration,
  );
  for (const operation of previousOperations) {
    operation.controller.abort();
    if (!removeOperation(operation)) reportCleanupFailure();
  }
  // Reuse startup initialization; resweeping here could remove a newer account's
  // active files. Failed deletions remain registered for foreground retry.
  await initializeUserDataExportDownloads();
}

export async function openUserDataExportDownload(request: UserDataExportDownloadRequest): Promise<void> {
  requireCurrentExport(request);
  if (!isUserDataExportDownloadUrl(request.url) || !/^[\w.-]+\.json$/.test(request.filename)) {
    throw new UserDataExportActionError('download_failed');
  }
  await initializeUserDataExportDownloads();
  requireCurrentExport(request);
  let sharing: typeof import('expo-sharing');
  let sharingAvailable: boolean;
  try {
    sharing = await import('expo-sharing');
    requireCurrentExport(request);
    sharingAvailable = await sharing.isAvailableAsync();
  } catch (error) {
    // Account changes take precedence over unavailable native modules. Recheck
    // after either await so cancellation remains silent in the caller.
    requireCurrentExport(request);
    if (error instanceof UserDataExportActionError) throw error;
    throw new UserDataExportActionError('sharing_unavailable');
  }
  requireCurrentExport(request);
  if (!sharingAvailable) throw new UserDataExportActionError('sharing_unavailable');

  let operation: ExportOperation;
  try {
    operation = {
      directory: new Directory(exportDirectory(), randomUUID()),
      credentialGeneration: request.credentialGeneration,
      controller: new AbortController(),
      downloading: false,
      sharing: false,
      removeRequested: false,
      activeCleanupStartedAt: null,
      activeCleanupRemainingMs: USER_DATA_EXPORT_ANDROID_CLEANUP_MS,
      cleanupTimer: null,
    };
  } catch {
    throw new UserDataExportActionError('download_failed');
  }
  operations.add(operation);
  const cancel = () => {
    operation.controller.abort();
    if (!removeOperation(operation)) reportCleanupFailure();
  };
  request.signal.addEventListener('abort', cancel, { once: true });
  let shared = false;
  let phase: 'download' | 'share' = 'download';
  let failure: UserDataExportActionError | null = null;
  try {
    requireCurrentExport(request);
    operation.directory.create({ intermediates: true });
    const destination = new File(operation.directory, request.filename);
    const task = File.createDownloadTask(request.url, destination, {
      sessionType: 'foreground',
      signal: operation.controller.signal,
    });
    operation.downloading = true;
    retainDownloadTask(task);
    try {
      const downloaded = await task.downloadAsync();
      if (!downloaded?.exists || downloaded.size === 0) throw new UserDataExportActionError('download_failed');
    } finally {
      operation.downloading = false;
      releaseDownloadTaskAfterNativeCompletion(task);
    }
    requireCurrentExport(request);
    if (operation.controller.signal.aborted) throw new UserDataExportActionError('session_changed');
    phase = 'share';
    operation.sharing = true;
    try {
      await sharing.shareAsync(destination.uri, { mimeType: 'application/json', UTI: 'public.json' });
      requireCurrentExport(request);
      if (operation.controller.signal.aborted) throw new UserDataExportActionError('session_changed');
      // Expo resolves on dismissal, including cancellation. It does not report
      // whether another app saved the file, so do not show a success claim.
      shared = true;
    } finally {
      operation.sharing = false;
    }
  } catch (error) {
    failure =
      request.signal.aborted || operation.controller.signal.aborted || !request.isCurrent()
        ? new UserDataExportActionError('session_changed')
        : error instanceof UserDataExportActionError
          ? error
          : new UserDataExportActionError(phase === 'share' ? 'share_failed' : 'download_failed');
  } finally {
    request.signal.removeEventListener('abort', cancel);
    if (shared && !operation.removeRequested && request.isCurrent() && Platform.OS === 'android') {
      // Android's chooser can resolve before the receiver has opened its URI.
      // Keep the file while away, plus a foreground grace period on return.
      scheduleAndroidCleanup(operation);
    } else if (!removeOperation(operation)) {
      // Preserve the original action failure while reporting the cleanup failure
      // separately. The owned directory stays registered for foreground retry.
      if (failure === null) failure = new UserDataExportActionError('cleanup_failed');
      else reportCleanupFailure();
    }
  }
  if (failure) throw failure;
}
