/** Private exports use HTTPS downloads, never app/deep links. */
export function isUserDataExportDownloadUrl(downloadUrl: string): boolean {
  try {
    const parsedUrl = new URL(downloadUrl);
    return parsedUrl.protocol === 'https:' && !parsedUrl.username && !parsedUrl.password;
  } catch {
    return false;
  }
}
