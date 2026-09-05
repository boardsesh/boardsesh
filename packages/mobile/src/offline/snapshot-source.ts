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

import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  isBackgrounded,
  onTeardown,
  SnapshotArtifactTruncatedError,
  SnapshotBackgroundTransferInterruptedError,
  SnapshotPermanentMissError,
  type SnapshotArtifactHandle,
  type SnapshotDownloadOptions,
  type SnapshotGradesArtifact,
  type SnapshotManifestEntry,
  type SnapshotSource,
} from '@boardsesh/offline-sync';
import { SNAPSHOT_BASE_URL } from '../lib/env';
import { SNAPSHOT_DIR_NAME } from './snapshot-paths';
import { reportHandledError } from '../lib/error-reporting';
import { resolveSnapshotDownloadStrategy, type SnapshotDownloadStrategy } from './download-strategy';
import { reportArtifactTransfer, type ArtifactTransferOutcome } from './artifact-transfer-telemetry';
import { assertNetworkAllowed } from '../lib/network-policy';

// Fixed per platform for the lifetime of the bundle: iOS uses a background
// URLSession so locking the phone does not kill a 100 MB transfer; Android uses
// the DownloadTask foreground arm (its native implementation ignores session
// type, but uses the task-specific OkHttp client).
const activeStrategy: SnapshotDownloadStrategy = resolveSnapshotDownloadStrategy(Platform.OS);

const MANIFEST_URL = `${SNAPSHOT_BASE_URL}/manifest.json`;
export const SNAPSHOT_MANIFEST_FETCH_TIMEOUT_MS = 15_000;

// The directory name lives in `snapshot-paths.ts` — an import-free module — so
// the cache sweeper can reap artifacts from the same directory this writes to
// without dragging `react-native` (imported above for `Platform.OS`) into its
// module graph. Re-exported here because this is where callers expect to find
// it, and re-literalling the name would silently sweep nothing if it ever moved.
export { SNAPSHOT_DIR_NAME } from './snapshot-paths';

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
/** The coarse multiplier, for artifacts the manifest gives no decoded size for. */
function gradesFreeSpaceMultiplier(contentEncoding: 'gzip' | 'identity'): number {
  return contentEncoding === 'gzip' ? GZIP_FREE_SPACE_SAFETY_MULTIPLIER : IDENTITY_FREE_SPACE_SAFETY_MULTIPLIER;
}

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
 * Drop artifacts for a SUPERSEDED build of this (board, layout) BEFORE the
 * download starts (issue #4390 asks for partials to be discarded by `builtAt`).
 *
 * `sweepRetainedArtifacts` already does this after a successful download, which
 * is one download too late: a 271 MB partial from an older build sits in the
 * cache until the NEXT download succeeds — and it may not, because that partial
 * counts against the free-space precheck the new download has to pass. Sweeping
 * first both discards the stale bytes and frees the space the new one needs.
 *
 * Whole-layout artifacts only: a grades file is named from its manifest key and
 * carries no `<board>-<layout>` prefix, so it is never recognised here.
 */
function sweepSupersededArtifacts(keepFileName: string): void {
  const keepPrefix = artifactNamePrefix(keepFileName);
  if (keepPrefix === null) return;
  let entries: (File | Directory)[];
  try {
    entries = snapshotDirectory().list();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    if (entry.uri.endsWith(COMPLETE_SIDECAR_SUFFIX)) continue;
    const name = entry.uri.slice(entry.uri.lastIndexOf('/') + 1);
    if (name === keepFileName) continue;
    if (artifactNamePrefix(entry.uri) !== keepPrefix) continue;
    deleteArtifactWithSidecar(entry);
  }
}

/**
 * The task strategy passes `sessionType` explicitly on both platforms so the
 * telemetry label and native behaviour cannot drift.
 */
async function runTransfer(args: {
  strategy: SnapshotDownloadStrategy;
  url: string;
  destination: File;
  onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void;
  signal?: AbortSignal;
}): Promise<File> {
  assertNetworkAllowed('catalog');
  const task = File.createDownloadTask(args.url, args.destination, {
    sessionType: args.strategy === 'task-background' ? 'background' : 'foreground',
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
  });
  try {
    const file = await task.downloadAsync();
    // `downloadAsync` resolves null ONLY when `pause()` was called, which we
    // never do. Treat it as a failed transfer rather than a silent success that
    // would hand the engine a handle to a file nobody wrote.
    if (!file) throw new Error('snapshot download: transfer ended without a file');
    return file;
  } finally {
    // Only after the promise settles: `release()` frees the native shared
    // object, and `sharedObjectDidRelease` cancels an in-flight call.
    task.release();
  }
}

/**
 * Fetch the manifest JSON. Returns `null` only when the manifest is genuinely
 * absent. HTTP outages and malformed responses throw so the engine retries the
 * manifest path instead of silently falling back to the paged crawl.
 */
async function fetchManifest(): Promise<unknown> {
  assertNetworkAllowed('catalog');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SNAPSHOT_MANIFEST_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store', signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`snapshot manifest fetch failed with HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Same idiom as `formatError` in offline-sync's mutation-queue/drainer.ts. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * NSURLErrorCannotDecodeRawData as surfaced by Expo's iOS DownloadTask. The
 * native exception currently exposes no stable numeric code to JavaScript, so
 * walk the bounded cause chain for its exact Foundation description.
 */
function isCannotDecodeRawDataError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object') return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && /cannot decode raw data/i.test(message)) return true;
  if (depth >= 3) return false;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isCannotDecodeRawDataError(cause, depth + 1);
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
/** Everything `downloadSnapshotFile` needs that differs between the two artifact kinds. */
type SnapshotArtifactRequest = {
  label: string;
  url: string;
  requiredBytes: number;
  contentEncoding: 'gzip' | 'identity';
  fileName: string;
  telemetryExtra: Record<string, unknown>;
  /** Telemetry dimension on `Offline Artifact Transfer`. */
  kind: 'layout' | 'grades';
  /** The stored object size — what the confirm dialog and the progress bar quote. */
  wireBytes: number;
  /**
   * The exact byte length the finished file must have, when the manifest can
   * say. Absent for a gzip artifact with no `uncompressedBytes` (every grades
   * block, and pre-#4311 layout entries), where there is nothing to compare to.
   */
  expectedDecodedBytes?: number;
  boardType?: string;
  layoutId?: number;
  /**
   * Build stamp for the completeness sidecar. Present only for the
   * whole-layout artifact: retention (#4310) is sized for its ~100 MB and its
   * supersede sweep recognises a build by the `<board>-<layout>` filename
   * prefix, which a grades file (named from its manifest key) does not carry.
   * Without it this function writes no sidecar, reuses nothing, and runs no
   * sweep — the engine deletes the file at the end of the cycle instead.
   */
  retainAs?: { builtAt: string };
};

/**
 * The shared download body for BOTH artifact kinds: superseded-partial sweep,
 * free-space check, content-addressed destination, transfer, the gzip magic-byte
 * sniff, and the exact decoded-size gate. The only differences between the
 * whole-layout artifact and the separate grades artifact are the filename, the
 * label in error messages, and retention — which only the whole-layout file gets
 * (`retainAs`).
 */
async function downloadSnapshotFile(
  artifact: SnapshotArtifactRequest,
  options?: SnapshotDownloadOptions,
): Promise<SnapshotArtifactHandle | null> {
  // Latched for this transfer, so a flag resolving mid-download cannot mislabel
  // the measurement it produces.
  const strategy = activeStrategy;
  const startedAt = Date.now();
  let firstByteMs: number | undefined;
  let backgroundedDuringTransfer = isBackgrounded();
  // The engine's own teardown subscription drives the pause/failure decision;
  // this one only records the fact for telemetry, which is why it reads the
  // guard rather than trusting the transition — and why there is no second
  // react-native AppState listener anywhere in this file.
  const unsubscribeTeardown = onTeardown(() => {
    if (isBackgrounded()) backgroundedDuringTransfer = true;
  });
  const emitTransfer = (
    outcome: ArtifactTransferOutcome,
    extra?: { bytesOnDisk?: number; sizeMismatch?: boolean },
  ): void => {
    reportArtifactTransfer({
      strategy,
      artifact: artifact.kind,
      ...(artifact.boardType !== undefined ? { boardType: artifact.boardType } : {}),
      ...(artifact.layoutId !== undefined ? { layoutId: artifact.layoutId } : {}),
      outcome,
      wireBytes: artifact.wireBytes,
      ...(artifact.expectedDecodedBytes !== undefined ? { expectedDecodedBytes: artifact.expectedDecodedBytes } : {}),
      ...(extra?.bytesOnDisk !== undefined ? { bytesOnDisk: extra.bytesOnDisk } : {}),
      wallMs: Date.now() - startedAt,
      ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      backgroundedDuringTransfer,
      resumed: false,
      ...(extra?.sizeMismatch !== undefined ? { sizeMismatch: extra.sizeMismatch } : {}),
    });
  };

  try {
    // Superseded partials FIRST (issue #4390 asks for stale partials to be
    // discarded by `builtAt`), because they are counted by the free-space check
    // on the very next line — a 271 MB leftover could otherwise fail the
    // precheck for the download that would have replaced it.
    if (artifact.retainAs) sweepSupersededArtifacts(artifact.fileName);

    const requiredBytes = artifact.requiredBytes;
    const availableBytes = Paths.availableDiskSpace;
    if (availableBytes < requiredBytes) {
      throw new Error(
        `snapshot download: insufficient disk space for ${artifact.label} ` +
          `(need ~${requiredBytes} bytes, have ${availableBytes} bytes free)`,
      );
    }

    const directory = snapshotDirectory();
    try {
      directory.create({ intermediates: true, idempotent: true });
    } catch (error) {
      throw new Error(`snapshot download: failed to create cache directory: ${formatError(error)}`, { cause: error });
    }

    const destination = new File(directory, artifact.fileName);

    // A retained artifact from an earlier cycle, complete and for this exact
    // build: hand it straight back, no event (no bytes moved). The engine still
    // runs quick_check and verifySnapshotMeta over it before importing a single
    // row, and treats an import failure on a reused file as delete-and-refetch
    // rather than a counted bootstrap attempt — so trusting the sidecar here
    // cannot strand a scope. The size is re-checked all the same: a survivor the
    // OS truncated under storage pressure carries a sidecar that now lies.
    //
    // ZERO BYTES MOVED IS LOAD-BEARING for the caller (issue #4310). This path
    // still counts as a successful download, so `clearTransportFailures` runs
    // against a file that demonstrated nothing about the network — which is why a
    // lock-contention import failure is charged to its own bounded `lockFailures`
    // budget rather than to transport. On transport it would be reset here every
    // cycle and never terminate, and a fresh scope would keep skipping its paged
    // crawl on the short cooldown: no board, by either path, ever.
    if (artifact.retainAs && destination.exists && hasCompleteSidecar(destination, artifact.retainAs.builtAt)) {
      if (artifact.expectedDecodedBytes === undefined || destination.size === artifact.expectedDecodedBytes) {
        return { filePath: toSqlitePath(destination.uri), reused: true };
      }
      deleteArtifactWithSidecar(destination);
    }
    // A file with no (or a mismatched) sidecar is a half-written download, not a
    // shortcut. Clear it so `idempotent: true` below never writes over a body it
    // cannot verify.
    if (destination.exists) deleteArtifactWithSidecar(destination);

    let downloaded: File;
    try {
      // Progress and cancellation ride the permanent DownloadTask path. Progress
      // is required for a truthful large-download UI; signal still lets a board
      // removal or sign-out stop bytes that can no longer be used.
      downloaded = await runTransfer({
        strategy,
        url: artifact.url,
        destination,
        signal: options?.signal,
        ...(options?.onProgress
          ? {
              onProgress: ({ bytesWritten, totalBytes }: { bytesWritten: number; totalBytes: number }) => {
                // Separates slow-to-start (DNS/TLS/CDN) from slow-throughput —
                // three lines that answer the first half of #4394 without a
                // second round trip to the CDN.
                if (firstByteMs === undefined && bytesWritten > 0) firstByteMs = Date.now() - startedAt;
                // Android reports -1 for a gzip body (OkHttp gunzips transparently,
                // so Content-Length is meaningless); the engine expects null for
                // "no usable total" and resolves the denominator itself.
                options.onProgress?.({ bytesWritten, totalBytes: totalBytes > 0 ? totalBytes : null });
              },
            }
          : {}),
      });
    } catch (error) {
      emitTransfer(options?.signal?.aborted === true ? 'aborted' : 'failed');
      // iOS's background URLSession can surface this response-decoding failure
      // before AppState delivers a background transition as well as while the
      // app is suspended. The native session type + exact Foundation message is
      // the stable signal; lifecycle timing is telemetry, not classification.
      if (strategy === 'task-background' && isCannotDecodeRawDataError(error)) {
        throw new SnapshotBackgroundTransferInterruptedError(
          `snapshot download: background transfer interrupted for ${artifact.label}: ${formatError(error)}`,
          { cause: error },
        );
      }
      throw new Error(`snapshot download: transfer failed for ${artifact.label}: ${formatError(error)}`, {
        cause: error,
      });
    }

    if (artifact.contentEncoding === 'gzip') {
      let stillCompressed: boolean;
      try {
        stillCompressed = await looksGzipCompressed(downloaded);
      } catch (error) {
        // Can't verify the body — treat it as untrustworthy, same as a failed
        // download. This was the last path that still `return null`ed, and it is
        // the one that reported `cause: null` to Sentry (issue #4238).
        safeDeleteFile(downloaded);
        emitTransfer('failed');
        throw new Error(
          `snapshot download: could not verify artifact encoding for ${artifact.label}: ${formatError(error)}`,
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
        // rollback signal, including for the background-URLSession rollout (a
        // background session runs out of nsurlsessiond, a different process from
        // the in-process sessions the gzip cutover was validated against).
        reportHandledError(
          new Error('snapshot artifact arrived still gzip-compressed (Content-Encoding was not auto-decoded)'),
          {
            tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' },
            extra: { ...artifact.telemetryExtra, strategy },
          },
        );
        emitTransfer('failed');
        throw new SnapshotPermanentMissError('snapshot artifact arrived still gzip-compressed');
      }
    }

    // The exact decoded-size gate (issue #4394). `uncompressedBytes` is the
    // SQLite file's own byte length (the export writes `rawBuffer.length`), so
    // this is unambiguous — and it is the one check that fires BEFORE the
    // sidecar is written, so a short or mixed-byte-space body can never be
    // retained, reused or ATTACHed. Deliberately AFTER the gzip sniff: a body
    // that is still compressed must keep reporting `permanent-miss`.
    const bytesOnDisk = downloaded.size;
    if (artifact.expectedDecodedBytes !== undefined && bytesOnDisk !== artifact.expectedDecodedBytes) {
      safeDeleteFile(downloaded);
      reportHandledError(new Error('snapshot artifact size mismatch'), {
        tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' },
        extra: {
          ...artifact.telemetryExtra,
          strategy,
          expectedDecodedBytes: artifact.expectedDecodedBytes,
          bytesOnDisk,
        },
      });
      emitTransfer('failed', { bytesOnDisk, sizeMismatch: true });
      throw new SnapshotArtifactTruncatedError(
        `snapshot download: short body for ${artifact.label} ` +
          `(expected ${artifact.expectedDecodedBytes} bytes, got ${bytesOnDisk})`,
      );
    }

    // Only now is the file provably complete AND decoded, so only now may a
    // later cycle reuse it. Retained artifacts only: a grades file is deleted by
    // the engine at the end of the cycle, so it neither claims a sidecar nor
    // triggers a sweep.
    if (artifact.retainAs) {
      writeCompleteSidecar(downloaded, artifact.retainAs.builtAt);
      sweepRetainedArtifacts(downloaded);
    }

    emitTransfer('completed', {
      bytesOnDisk,
      ...(artifact.expectedDecodedBytes !== undefined ? { sizeMismatch: false } : {}),
    });
    return { filePath: toSqlitePath(downloaded.uri) };
  } finally {
    unsubscribeTeardown();
  }
}

/**
 * The exact byte length a finished artifact must have, or undefined when the
 * manifest cannot say. An `identity` entry's `bytes` IS the decoded size (the
 * `board-snapshots/v1/` rollback prefix); a gzip entry needs
 * `uncompressedBytes`, which every live grades block and every pre-#4311 layout
 * entry lacks.
 */
function expectedDecodedBytesFor(entry: {
  bytes: number;
  contentEncoding: 'gzip' | 'identity';
  uncompressedBytes?: number;
}): number | undefined {
  if (typeof entry.uncompressedBytes === 'number' && entry.uncompressedBytes > 0) return entry.uncompressedBytes;
  return entry.contentEncoding === 'identity' ? entry.bytes : undefined;
}

async function downloadArtifact(
  entry: SnapshotManifestEntry,
  options?: SnapshotDownloadOptions,
): Promise<SnapshotArtifactHandle | null> {
  // Content-addressed filename (boardType/layoutId/builtAt) so a retried
  // download for the same artifact overwrites cleanly (idempotent: true)
  // instead of accumulating orphaned files across bootstrap attempts.
  const safeBuiltAt = entry.builtAt.replace(/[^a-zA-Z0-9]/g, '-');
  return downloadSnapshotFile(
    {
      label: `${entry.boardType}:${entry.layoutId}`,
      url: entry.url,
      requiredBytes: requiredFreeBytes(entry),
      contentEncoding: entry.contentEncoding,
      fileName: `${entry.boardType}-${entry.layoutId}-${safeBuiltAt}.db`,
      telemetryExtra: { boardType: entry.boardType, layoutId: entry.layoutId, url: entry.url },
      kind: 'layout',
      wireBytes: entry.bytes,
      ...(expectedDecodedBytesFor(entry) !== undefined ? { expectedDecodedBytes: expectedDecodedBytesFor(entry) } : {}),
      boardType: entry.boardType,
      layoutId: entry.layoutId,
      retainAs: { builtAt: entry.builtAt },
    },
    options,
  );
}

/**
 * The layout's separate Boardsesh-grades artifact (issue #4310). Small next to
 * the climbs file — a few MB against ~100 — but it removes hundreds of serial
 * authenticated GraphQL pages from every Kilter and Tension download.
 *
 * The filename is derived from the artifact KEY rather than from a board/layout
 * pair, because the manifest's grades block does not carry them; the key is
 * already content-addressed by build stamp, so it is unique per build.
 */
async function downloadGradesArtifact(artifact: SnapshotGradesArtifact): Promise<{ filePath: string } | null> {
  const safeKey = artifact.key.replace(/[^a-zA-Z0-9]/g, '-');
  return downloadSnapshotFile({
    label: `grades ${artifact.key}`,
    url: artifact.url,
    // No `uncompressedBytes` in the manifest's grades block, so this is the
    // coarse multiplier path — cheap either way at a few MB.
    requiredBytes: artifact.bytes * gradesFreeSpaceMultiplier(artifact.contentEncoding),
    contentEncoding: artifact.contentEncoding,
    fileName: `${safeKey}.db`,
    telemetryExtra: { gradesKey: artifact.key, url: artifact.url },
    kind: 'grades',
    wireBytes: artifact.bytes,
    // A gzip grades block carries no `uncompressedBytes` (verified against the
    // live manifest), so the size gate applies to layout artifacts by
    // construction — and to an identity grades artifact, where `bytes` IS the
    // decoded size.
    ...(expectedDecodedBytesFor(artifact) !== undefined
      ? { expectedDecodedBytes: expectedDecodedBytesFor(artifact) }
      : {}),
  });
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
  downloadGradesArtifact,
  deleteArtifact,
  releaseArtifact,
};
