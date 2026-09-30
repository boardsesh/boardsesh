import { openValidatedUrl } from './open-external-link';
import { isUserDataExportDownloadUrl } from './user-data-export-download-url';

/** Attachment downloads need the system browser rather than an in-app viewer. */
export function openUserDataExportDownload(downloadUrl: string): Promise<boolean> {
  return openValidatedUrl(downloadUrl, isUserDataExportDownloadUrl);
}
