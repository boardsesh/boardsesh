// Byte counts as people read them on a phone.

const KB = 1000;
const MB = 1000 * KB;
const GB = 1000 * MB;

/**
 * Format a byte count for display, e.g. `"412 MB"` / `"1.2 GB"`.
 *
 * Decimal units (1 MB = 1,000,000 B), matching how iOS and Android report storage —
 * this number sits next to the OS's own figure in the user's head, so it must use the
 * OS's convention rather than the binary one. Units are not translated: MB/GB are the
 * same in every locale we ship.
 */
export function formatStorageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= GB) {
    // One decimal below 10 GB ("1.2 GB"), none above ("128 GB") — precision people
    // can act on, without the noise.
    const value = bytes / GB;
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} GB`;
  }
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  // Anything smaller is noise on a storage screen; don't render "437 B".
  return '1 KB';
}
