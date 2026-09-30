import { isUserDataExportDownloadUrl } from './user-data-export-download-url';

/** Same-tab attachment navigation works after a fresh-link fetch without a popup. */
export async function openUserDataExportDownload(downloadUrl: string): Promise<boolean> {
  if (typeof window === 'undefined' || !isUserDataExportDownloadUrl(downloadUrl)) return false;
  try {
    window.location.assign(downloadUrl);
    return true;
  } catch {
    return false;
  }
}
