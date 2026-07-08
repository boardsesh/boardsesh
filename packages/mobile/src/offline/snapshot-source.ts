// Mobile SnapshotSource: the platform I/O the offline-sync engine's snapshot
// bootstrap phase (@boardsesh/offline-sync's snapshot-bootstrap.ts, "Phase 3")
// injects to warm a freshly-enabled board scope from a pre-built artifact
// instead of paging the whole catalog over GraphQL. See
// packages/backend/src/scripts/export-board-snapshots.ts for what this
// downloads: a per-(boardType, layoutId) SQLite file gzipped and uploaded to
// Tigris/S3 under `board-snapshots/v1/`, served with `Content-Encoding: gzip`
// (so a compliant HTTP stack decompresses it transparently while downloading)
// plus `manifest.json` listing every artifact's URL, size, and resume
// watermarks.
//
// The engine only consumes what this returns — it never fetches, downloads, or
// gunzips anything itself (see snapshot-bootstrap.ts's `SnapshotSource`
// contract). Every failure path here (disk space, download error, a stubborn
// gzip body) returns `null`/throws, which the engine counts as one bootstrap
// attempt and falls back to the ordinary paged crawl (MAX_BOOTSTRAP_ATTEMPTS
// caps it at two tries before giving up on the snapshot path for that scope).

import { Directory, File, Paths } from 'expo-file-system';
import type { SnapshotManifestEntry, SnapshotSource } from '@boardsesh/offline-sync';
import { SNAPSHOT_BASE_URL } from '../lib/env';
import { reportHandledError } from '../lib/error-reporting';

const MANIFEST_URL = `${SNAPSHOT_BASE_URL}/manifest.json`;

// Cache-dir subfolder for downloaded artifacts. The engine ATTACHes the file,
// imports the scope's rows, then calls `deleteArtifact` once it's done with
// it (in a `finally`) — nothing here is meant to persist across app launches,
// so the OS is also free to reclaim it under storage pressure (Paths.cache,
// not Paths.document).
const SNAPSHOT_DIR_NAME = 'board-snapshots';

// The space a download could occupy is bounded by whichever is larger: the
// gzip-on-the-wire size (if the platform does NOT auto-decompress and we end
// up deleting it) or the decompressed SQLite file (if it does — board_climbs +
// board_climb_stats are text-heavy, so gzip commonly gets 4-8x on this data).
// This multiplier is a deliberately conservative ceiling on top of
// `entry.bytes` (the gzip size) so a marginal device never gets walked into
// running out of disk mid-download — a `null` here just falls back to the
// paged crawl, so there is no cost to erring generous.
const FREE_SPACE_SAFETY_MULTIPLIER = 6;

const GZIP_MAGIC_BYTE_0 = 0x1f;
const GZIP_MAGIC_BYTE_1 = 0x8b;

function snapshotDirectory(): Directory {
  return new Directory(Paths.cache, SNAPSHOT_DIR_NAME);
}

/**
 * A plain filesystem path (no `file://` scheme) for the SQLite ATTACH
 * statement in snapshot-bootstrap.ts. SQLite's ATTACH filename resolution only
 * reliably accepts a bare path unless the connection was explicitly opened in
 * URI mode — expo-sqlite does not guarantee that, so stripping the scheme here
 * (rather than trusting `file://` to work) is the portable choice across both
 * platforms' bundled sqlite3.
 */
function toSqlitePath(fileUri: string): string {
  return fileUri.startsWith('file://') ? fileUri.slice('file://'.length) : fileUri;
}

/** Inverse of `toSqlitePath`, for reconstructing a `File` from the plain path the engine hands back to `deleteArtifact`. */
function toFileUri(sqlitePath: string): string {
  return sqlitePath.startsWith('file://') ? sqlitePath : `file://${sqlitePath}`;
}

/**
 * True when `file`'s first two bytes are the gzip magic number — i.e. the
 * native HTTP stack did NOT transparently decompress a `Content-Encoding:
 * gzip` response body, and the file on disk is still the raw gzip stream.
 * Reads only the stream's first chunk (never the whole file), so this stays
 * cheap even for a large artifact.
 */
async function looksGzipCompressed(file: File): Promise<boolean> {
  const reader = file.readableStream().getReader();
  try {
    const { value } = await reader.read();
    if (!value || value.byteLength < 2) return false;
    return value[0] === GZIP_MAGIC_BYTE_0 && value[1] === GZIP_MAGIC_BYTE_1;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Best-effort delete — a leftover partial/bad file just wastes cache space until the OS reclaims it. */
function safeDeleteFile(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Ignore — see above.
  }
}

/**
 * Fetch the manifest JSON. Returns `null` on a non-200 response (the engine
 * treats that as "not published yet this cycle" — a permanent miss that burns
 * no bootstrap attempt). Network/transport errors are left to throw, which the
 * engine DOES count as an attempt (see `resolveManifestOnce` in pull-client.ts).
 */
async function fetchManifest(): Promise<unknown> {
  const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) return null;
  return response.json();
}

async function downloadArtifact(entry: SnapshotManifestEntry): Promise<{ filePath: string } | null> {
  const requiredBytes = entry.bytes * FREE_SPACE_SAFETY_MULTIPLIER;
  if (Paths.availableDiskSpace < requiredBytes) return null;

  const directory = snapshotDirectory();
  try {
    directory.create({ intermediates: true, idempotent: true });
  } catch {
    return null;
  }

  // Content-addressed filename (boardType/layoutId/builtAt) so a retried
  // download for the same artifact overwrites cleanly (idempotent: true below)
  // instead of accumulating orphaned files across bootstrap attempts.
  const safeBuiltAt = entry.builtAt.replace(/[^a-zA-Z0-9]/g, '-');
  const destination = new File(directory, `${entry.boardType}-${entry.layoutId}-${safeBuiltAt}.db`);

  let downloaded: File;
  try {
    downloaded = await File.downloadFileAsync(entry.url, destination, { idempotent: true });
  } catch {
    return null;
  }

  if (entry.contentEncoding === 'gzip') {
    let stillCompressed: boolean;
    try {
      stillCompressed = await looksGzipCompressed(downloaded);
    } catch {
      // Can't verify the body — treat it as untrustworthy, same as a failed download.
      safeDeleteFile(downloaded);
      return null;
    }
    if (stillCompressed) {
      safeDeleteFile(downloaded);
      // Expected behaviour is that the native HTTP stack (NSURLSession /
      // OkHttp) auto-decodes a gzip Content-Encoding while downloading — this
      // path should be rare-to-never. Report it as a handled error (not just a
      // dev warning) so a real pattern shows up in Sentry; if it turns out to
      // be common on some platform/OS combo, the fix is to flip the export job
      // to `contentEncoding: 'identity'` rather than trying to gunzip client-side.
      reportHandledError(
        new Error('snapshot artifact arrived still gzip-compressed (Content-Encoding was not auto-decoded)'),
        {
          tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' },
          extra: { boardType: entry.boardType, layoutId: entry.layoutId, url: entry.url },
        },
      );
      return null;
    }
  }

  return { filePath: toSqlitePath(downloaded.uri) };
}

async function deleteArtifact(filePath: string): Promise<void> {
  safeDeleteFile(new File(toFileUri(filePath)));
}

export const mobileSnapshotSource: SnapshotSource = {
  fetchManifest,
  downloadArtifact,
  deleteArtifact,
};
