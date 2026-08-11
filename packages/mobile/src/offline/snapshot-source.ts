// Mobile SnapshotSource: the platform I/O the offline-sync engine's snapshot
// bootstrap phase (@boardsesh/offline-sync's snapshot-bootstrap.ts, "Phase 3")
// injects to warm a freshly-enabled board scope from a pre-built artifact
// instead of paging the whole catalog over GraphQL. See
// packages/backend/src/scripts/export-board-snapshots.ts for what this
// downloads: a per-(boardType, layoutId) SQLite file uploaded to Tigris/S3
// under `board-snapshots/v1-gzip/` (the prefix the shipped builds point at),
// plus `manifest.json` listing every artifact's URL, stored size, content
// encoding, and resume watermarks. Live artifacts are gzip-encoded and this
// adapter verifies the body was decoded before handing the file to SQLite; the
// identity prefix (`board-snapshots/v1/`) is still published as a rollback
// target, so the identity path below stays load-bearing.
//
// The engine only consumes what this returns — it never fetches, downloads, or
// gunzips anything itself (see snapshot-bootstrap.ts's `SnapshotSource`
// contract). EVERY failure path here (disk space, directory creation, download
// error, an unreadable body, a stubborn gzip body) THROWS a descriptive Error
// carrying the underlying exception as its `cause`, and the engine reports that
// chain — see `runBootstrapPhase`'s `cachedDownload` handling in pull-client.ts.
// A transport-shaped cause is reported as a warning rather than an error; every
// failure the engine sees from `downloadArtifact` still burns an attempt, and
// MAX_BOOTSTRAP_ATTEMPTS caps it at two tries before the scope settles into
// the ordinary paged crawl (issue #4106: these used to `return null` on real
// failures, which is a legal contract but reported `cause: null` for
// everything; issue #4238: the causes that survived were only interpolated into
// the message, so the classifier could not see them and every offline user's
// failure landed as a Sentry `error`).

import { Directory, File, Paths } from 'expo-file-system';
import { SnapshotPermanentMissError, type SnapshotManifestEntry, type SnapshotSource } from '@boardsesh/offline-sync';
import { SNAPSHOT_BASE_URL } from '../lib/env';
import { reportHandledError } from '../lib/error-reporting';

const MANIFEST_URL = `${SNAPSHOT_BASE_URL}/manifest.json`;

// Cache-dir subfolder for downloaded artifacts. The engine ATTACHes the file,
// imports the scope's rows, then calls `deleteArtifact` once it's done with
// it (in a `finally`) — nothing here is meant to persist across app launches,
// so the OS is also free to reclaim it under storage pressure (Paths.cache,
// not Paths.document).
const SNAPSHOT_DIR_NAME = 'board-snapshots';

// Identity artifacts are already stored as SQLite files, so they only need room
// for the download plus write overhead. Gzip artifacts may temporarily require
// the compressed object and the decompressed SQLite file; board_climbs +
// board_climb_stats are text-heavy, so keep that path deliberately conservative.
const IDENTITY_FREE_SPACE_SAFETY_MULTIPLIER = 2;
const GZIP_FREE_SPACE_SAFETY_MULTIPLIER = 6;

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
 * A ReadableStream may legally yield empty (or 1-byte) chunks before real
 * data, so this keeps reading until it has the two header bytes or EOF — but
 * never more than that, so it stays cheap even for a large artifact.
 */
async function looksGzipCompressed(file: File): Promise<boolean> {
  const reader = file.readableStream().getReader();
  try {
    const header: number[] = [];
    while (header.length < 2) {
      const { value, done } = await reader.read();
      if (done) return false; // < 2 bytes total — not a gzip stream
      for (const byte of value ?? []) {
        header.push(byte);
        if (header.length === 2) break;
      }
    }
    return header[0] === GZIP_MAGIC_BYTE_0 && header[1] === GZIP_MAGIC_BYTE_1;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Best-effort delete — a leftover partial/bad file just wastes cache space until the OS reclaims it. */
function safeDeleteFile(file: File): void {
  try {
    // `exists` is a synchronous property on SDK 57's File API (older expo-file-system
    // versions exposed an async `exists()` — revisit if the SDK pin moves).
    if (file.exists) file.delete();
  } catch {
    // Ignore — see above.
  }
}

/**
 * Fetch the manifest JSON. Returns `null` only when the manifest is genuinely
 * absent or unparseable (permanent miss this cycle, no attempt). HTTP outages
 * throw so the engine treats them as retryable manifest errors.
 */
async function fetchManifest(): Promise<unknown> {
  const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`snapshot manifest fetch failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Same idiom as `formatError` in offline-sync's mutation-queue/drainer.ts. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The disk-space, directory-creation, and actual-download failure branches
 * below used to `return null` on a real error, which is a legal SnapshotSource
 * contract (see the doc comment on downloadArtifact in snapshot-bootstrap.ts —
 * "return null or throw, both count as an attempt"), but it meant
 * `runBootstrapPhase`'s `cachedDownload.cause` (only ever set inside a
 * `catch`) stayed `null` for every one of these — so Sentry's
 * `reportSnapshotBootstrapError` reported `cause: null` for every real-world
 * download failure, with no way to tell a 404 from a timeout from a disk-full
 * device without reproducing it (issue #4106).
 *
 * Each wrapper keeps the underlying exception as its `cause` as well as in its
 * message. The message alone reads fine in Sentry's title but is invisible to
 * the shared transport classifier, which walks `.cause` — and that classifier is
 * what decides whether expo-file-system's `UnableToDownloadException("The
 * request timed out.")` is an offline user (a warning) or a real fault (an
 * error). Issue #4238.
 */
async function downloadArtifact(entry: SnapshotManifestEntry): Promise<{ filePath: string } | null> {
  const freeSpaceSafetyMultiplier =
    entry.contentEncoding === 'gzip' ? GZIP_FREE_SPACE_SAFETY_MULTIPLIER : IDENTITY_FREE_SPACE_SAFETY_MULTIPLIER;
  const requiredBytes = entry.bytes * freeSpaceSafetyMultiplier;
  const availableBytes = Paths.availableDiskSpace;
  if (availableBytes < requiredBytes) {
    throw new Error(
      `snapshot download: insufficient disk space for ${entry.boardType}:${entry.layoutId} ` +
        `(need ~${requiredBytes} bytes, have ${availableBytes} bytes free)`,
    );
  }

  const directory = snapshotDirectory();
  try {
    directory.create({ intermediates: true, idempotent: true });
  } catch (error) {
    throw new Error(`snapshot download: failed to create cache directory: ${formatError(error)}`, { cause: error });
  }

  // Content-addressed filename (boardType/layoutId/builtAt) so a retried
  // download for the same artifact overwrites cleanly (idempotent: true below)
  // instead of accumulating orphaned files across bootstrap attempts.
  const safeBuiltAt = entry.builtAt.replace(/[^a-zA-Z0-9]/g, '-');
  const destination = new File(directory, `${entry.boardType}-${entry.layoutId}-${safeBuiltAt}.db`);

  let downloaded: File;
  try {
    downloaded = await File.downloadFileAsync(entry.url, destination, { idempotent: true });
  } catch (error) {
    throw new Error(
      `snapshot download: File.downloadFileAsync failed for ${entry.boardType}:${entry.layoutId}: ${formatError(error)}`,
      { cause: error },
    );
  }

  if (entry.contentEncoding === 'gzip') {
    let stillCompressed: boolean;
    try {
      stillCompressed = await looksGzipCompressed(downloaded);
    } catch (error) {
      // Can't verify the body — treat it as untrustworthy, same as a failed
      // download. This was the last path that still `return null`ed, and it is
      // the one that reported `cause: null` to Sentry (issue #4238).
      safeDeleteFile(downloaded);
      throw new Error(
        `snapshot download: could not verify artifact encoding for ${entry.boardType}:${entry.layoutId}: ${formatError(error)}`,
        { cause: error },
      );
    }
    if (stillCompressed) {
      safeDeleteFile(downloaded);
      // Expected behaviour is that the native HTTP stack (NSURLSession /
      // OkHttp) auto-decodes a gzip Content-Encoding while downloading — this
      // path should be rare-to-never (validated on Android/OkHttp and iOS 26.5.2
      // before the fleet was cut over to the gzip prefix). Report it as a handled
      // error (not just a dev warning) so a real pattern shows up in Sentry —
      // it's now the live download path, and a spike here is the cutover's
      // rollback signal.
      reportHandledError(
        new Error('snapshot artifact arrived still gzip-compressed (Content-Encoding was not auto-decoded)'),
        {
          tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' },
          extra: { boardType: entry.boardType, layoutId: entry.layoutId, url: entry.url },
        },
      );
      throw new SnapshotPermanentMissError('snapshot artifact arrived still gzip-compressed');
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
