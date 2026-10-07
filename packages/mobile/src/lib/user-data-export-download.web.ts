import {
  requireCurrentExport,
  UserDataExportActionError,
  type UserDataExportDownloadRequest,
} from './user-data-export-action';
import { isUserDataExportDownloadUrl } from './user-data-export-download-url';

export async function initializeUserDataExportDownloads(): Promise<void> {}
export async function clearUserDataExportDownloads(_departingGeneration: number): Promise<void> {}

/** Same-tab attachment navigation works after a fresh-link fetch without a popup. */
export async function openUserDataExportDownload(request: UserDataExportDownloadRequest): Promise<void> {
  requireCurrentExport(request);
  if (typeof window === 'undefined' || !isUserDataExportDownloadUrl(request.url)) {
    throw new UserDataExportActionError('browser_failed');
  }
  try {
    window.location.assign(request.url);
  } catch {
    throw new UserDataExportActionError('browser_failed');
  }
}
