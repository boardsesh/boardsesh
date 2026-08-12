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
import {
  SnapshotPermanentMissError,
  type SnapshotArtifactHandle,
  type SnapshotDownloadOptions,
  type SnapshotManifestEntry,
  type SnapshotSource,
} from '@boardsesh/offline-sync';
import { SNAPSHOT_BASE_URL } from '../lib/env';
import { reportHandledError } from '../lib/error-reporting';

const MANIFEST_URL = `${SNAPSHOT_BASE_URL}/manifest.json`;

// Cache-dir subfolder for downloaded artifacts. The engine ATTACHes the file,
// imports the scope's rows, then hands it back through `releaseArtifact`.
// Since issue #4310 a file the engine did NOT import survives to the next
// cycle (see the retention notes below), but it still lives under Paths.cache,
// not Paths.document: the OS may reclaim it under storage pressure and losing
// it costs a re-download, never data.
// Exported so the cache sweeper (lib/sweep-caches.ts) reaps artifacts leaked by
// a kill mid-bootstrap from the same directory this writes to, rather than
// re-literalling the name and silently sweeping nothing if it ever moves.
export const SNAPSHOT_DIR_NAME = 'board-snapshots';

// Written next to `<artifact>.db` once the download AND the gzip sniff have
// both passed, holding the artifact's `builtAt`. Retention is only useful if a
// half-written file can never be reused — the file's own size is no help
// (`entry.bytes` is the STORED gzip size, the file on disk is decompressed),
// so the sidecar is the completeness proof. No sidecar → re-download.
const COMPLETE_SIDECAR_SUFFIX = '.complete';

// How much of the cache directory retained artifacts may occupy, and the free
// space below which retention is abandoned entirely. Retaining a Kilter
// artifact is ~271 MB decompressed, which is worth it (it saves re-downloading
// 103 MB over a phone connection) but only while the device can spare it —
// offline mode's storage footprint is already a live complaint (issue #3647).
const RETENTION_BUDGET_BYTES = 400 * 1024 * 1024;
const RETENTION_FREE_SPACE_FLOOR_BYTES = 1.5 * 1024 * 1024 * 1024;

// Identity artifacts are already stored as SQLite files, so they only need room
// for the download plus write overhead. Gzip artifacts may temporarily require
// the compressed object and the decompressed SQLite file; board_climbs +
// board_climb_stats are text-heavy, so keep that path deliberately conservative.
//
// These are GUESSES, and the gzip one is expensive: 6× a 103 MB artifact demands
// ~618 MB free to download a file that needs ~374 MB, so a storage-tight phone
// is refused a download it could have completed. They are now only the fallback
// for manifest entries built before `uncompressedBytes` shipped (issue #4311) —
// with that field the requirement is computed exactly in `requiredFreeBytes`.
const IDENTITY_FREE_SPACE_SAFETY_MULTIPLIER = 2;
const GZIP_FREE_SPACE_SAFETY_MULTIPLIER = 6;

// Headroom over the exact figure: SQLite journal/WAL side files during the
// import, plus filesystem block rounding.
const EXACT_FREE_SPACE_SLACK_BYTES = 32 * 1024 * 1024;

/**
 * Free disk space this download needs. Exact when the manifest carries the
 * decoded artifact size — the compressed body and the decompressed SQLite file
 * can both be on disk at once, so it is the sum plus slack — and a coarse
 * multiplier otherwise.
 */
function requiredFreeBytes(entry: SnapshotManifestEntry): number {
  if (typeof entry.uncompressedBytes === 'number' && entry.uncompressedBytes > 0) {
    return entry.uncompressedBytes + entry.bytes + EXACT_FREE_SPACE_SLACK_BYTES;
  }
  const multiplier =
    entry.contentEncoding === 'gzip' ? GZIP_FREE_SPACE_SAFETY_MULTIPLIER : IDENTITY_FREE_SPACE_SAFETY_MULTIPLIER;
  return entry.bytes * multiplier;
}

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

// --- Retention (issue #4310) --------------------------------------------------

function sidecarFor(artifact: File): File {
  return new File(`${artifact.uri}${COMPLETE_SIDECAR_SUFFIX}`);
}

/** Delete an artifact and its completeness sidecar together — never one alone. */
function deleteArtifactWithSidecar(artifact: File): void {
  safeDeleteFile(sidecarFor(artifact));
  safeDeleteFile(artifact);
}

/**
 * True when this exact file was fully downloaded and verified in an earlier
 * cycle: the sidecar exists AND names the same `builtAt` the manifest is asking
 * for. A filename match alone is not enough — a crash between `create` and the
 * first byte leaves a plausible-looking name over an empty file.
 */
function hasCompleteSidecar(artifact: File, builtAt: string): boolean {
  try {
    const sidecar = sidecarFor(artifact);
    if (!sidecar.exists) return false;
    return sidecar.textSync().trim() === builtAt;
  } catch {
    return false;
  }
}

function writeCompleteSidecar(artifact: File, builtAt: string): void {
  try {
    const sidecar = sidecarFor(artifact);
    sidecar.create({ overwrite: true, intermediates: true });
    sidecar.write(builtAt);
  } catch {
    // A missing sidecar only costs a re-download next cycle; never fail the
    // import over it.
  }
}

/**
 * Drop retained artifacts that no longer earn their space: anything for a
 * DIFFERENT build of the same (board, layout) than the one just downloaded
 * (superseded — the manifest will never ask for it again), and then, oldest
 * first, whatever it takes to get under the byte budget. Called after each
 * successful download, so the budget is enforced at the moment the directory
 * grows rather than on a timer.
 *
 * `keep` — the file this cycle just downloaded — is never evicted (the import is
 * about to read it) but DOES count against the budget. A cycle cut short retains
 * it like any other artifact, so excluding it would let the directory settle at
 * budget-plus-one-artifact: a 350 MB survivor passes a 400 MB budget, a 271 MB
 * Kilter file is then retained beside it, and the "400 MB" cap holds 621 MB.
 *
 * Coordination note for the image/thumbnail cache sweeper (issue #3647): this
 * directory owns its own budget. A sweeper that also deletes here would
 * silently reintroduce "backgrounding costs you the whole download".
 */
function sweepRetainedArtifacts(keep: File): void {
  let entries: (File | Directory)[];
  try {
    entries = snapshotDirectory().list();
  } catch {
    return;
  }

  const artifacts: File[] = [];
  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    if (entry.uri.endsWith(COMPLETE_SIDECAR_SUFFIX)) continue;
    artifacts.push(entry);
  }

  // Below the free-space floor, retention stops being a kindness — nothing is
  // kept except the artifact this cycle is about to import.
  const belowFreeSpaceFloor = Paths.availableDiskSpace < RETENTION_FREE_SPACE_FLOOR_BYTES;

  const keepPrefix = artifactNamePrefix(keep.uri);
  const survivors: { file: File; size: number; modifiedAt: number }[] = [];
  for (const artifact of artifacts) {
    if (artifact.uri === keep.uri) continue;
    // Same (board, layout), different build stamp → the manifest has moved on.
    const isSuperseded = keepPrefix !== null && artifactNamePrefix(artifact.uri) === keepPrefix;
    if (belowFreeSpaceFloor || isSuperseded) {
      deleteArtifactWithSidecar(artifact);
      continue;
    }
    survivors.push({
      file: artifact,
      size: artifact.size,
      modifiedAt: artifact.lastModified ?? 0,
    });
  }

  // Starts at the kept file's own size — see the note above.
  let retainedBytes = survivors.reduce((total, survivor) => total + survivor.size, keep.size);
  if (retainedBytes <= RETENTION_BUDGET_BYTES) return;
  survivors.sort((left, right) => left.modifiedAt - right.modifiedAt);
  for (const survivor of survivors) {
    if (retainedBytes <= RETENTION_BUDGET_BYTES) break;
    deleteArtifactWithSidecar(survivor.file);
    retainedBytes -= survivor.size;
  }
}

/**
 * `<board>-<layout>` from a `<board>-<layout>-<builtAt>.db` artifact URI, or
 * null when the name doesn't match — an unrecognised file is left alone rather
 * than guessed at.
 */
function artifactNamePrefix(uri: string): string | null {
  const name = uri.slice(uri.lastIndexOf('/') + 1);
  const match = name.match(/^([a-z0-9]+-\d+)-/i);
  return match ? match[1] : null;
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
async function downloadArtifact(
  entry: SnapshotManifestEntry,
  options?: SnapshotDownloadOptions,
): Promise<SnapshotArtifactHandle | null> {
  const requiredBytes = requiredFreeBytes(entry);
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

  // A retained artifact from an earlier cycle, complete and for this exact
  // build: hand it straight back. The engine still runs quick_check and
  // verifySnapshotMeta over it before importing a single row, and treats an
  // import failure on a reused file as delete-and-refetch rather than a counted
  // bootstrap attempt — so trusting the sidecar here cannot strand a scope.
  if (destination.exists && hasCompleteSidecar(destination, entry.builtAt)) {
    return { filePath: toSqlitePath(destination.uri), reused: true };
  }
  // A file with no (or a mismatched) sidecar is a half-written download, not a
  // shortcut. Clear it so `idempotent: true` below never writes over a body it
  // cannot verify.
  if (destination.exists) deleteArtifactWithSidecar(destination);

  let downloaded: File;
  try {
    // `onProgress` is only passed when the caller asked for it (the engine
    // omits it when the kill switch is off), because supplying it makes
    // expo-file-system take a different native download implementation — an
    // 8 KB streaming copy loop on Android, a delegate-driven URLSession on iOS
    // — rather than its plain path. Omitting it keeps the call byte-identical
    // to the pre-#4311 one. `signal` rides both shapes: it only cancels the
    // transfer and does not switch implementations.
    downloaded = await File.downloadFileAsync(
      entry.url,
      destination,
      options?.onProgress
        ? {
            idempotent: true,
            signal: options.signal,
            onProgress: ({ bytesWritten, totalBytes }) => {
              // Android reports -1 for a gzip body (OkHttp gunzips transparently,
              // so Content-Length is meaningless); the engine expects null for
              // "no usable total" and resolves the denominator itself.
              options.onProgress?.({ bytesWritten, totalBytes: totalBytes > 0 ? totalBytes : null });
            },
          }
        : { idempotent: true, signal: options?.signal },
    );
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

  // Only now is the file provably complete AND decoded, so only now may a
  // later cycle reuse it.
  writeCompleteSidecar(downloaded, entry.builtAt);
  sweepRetainedArtifacts(downloaded);

  return { filePath: toSqlitePath(downloaded.uri) };
}

async function deleteArtifact(filePath: string): Promise<void> {
  deleteArtifactWithSidecar(new File(toFileUri(filePath)));
}

/**
 * The engine is done with this artifact for the cycle. Imported → delete it,
 * the rows are in the database now. NOT imported → keep it: the cycle was cut
 * short (backgrounded, wiped, another scope failed) and re-downloading 103 MB
 * on the next wake is the failure this retention exists to remove (issue
 * #4310). The budget sweep already ran at download time.
 */
async function releaseArtifact(filePath: string, options: { imported: boolean }): Promise<void> {
  if (options.imported) deleteArtifactWithSidecar(new File(toFileUri(filePath)));
}

export const mobileSnapshotSource: SnapshotSource = {
  fetchManifest,
  downloadArtifact,
  deleteArtifact,
  releaseArtifact,
};
