/**
 * Download, verify and cache the hold-detector weights (epic #5346, SW-02).
 *
 * The model is NEVER a JS asset. `require()`-ing a 31 MB `.onnx` would put it in
 * every OTA bundle, for every user, whether or not they own a spray wall, and it
 * would take a store release to change. Instead the manifest at
 * `models/hold-detector/<version>/manifest.json` in the public media bucket is
 * the only mutable pointer, the weight files under that prefix are immutable per
 * version, and this module pulls them into the cache directory on first use.
 *
 * Every failure resolves to `null`. Offline, a 404, a manifest that does not
 * validate, a sha256 that does not match, a full disk — the caller's answer is
 * always "no model, place the holds by hand", and an exception crossing into a
 * screen would turn a bad JSON deploy into a crash. The only thing a mismatch
 * does beyond returning null is DELETE the file it just wrote, so a corrupted
 * download can't be picked up as a cache hit on the next launch.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { type ModelManifest, type ModelManifestFile, parseModelManifest, selectInt8File } from './manifest';
import { Sha256 } from './sha256';

/**
 * Public media bucket base. Same host the backend's `/static/*` redirect points
 * at (`docs/user-media-storage.md`); overridable so a build can point at a
 * staging bucket. `EXPO_PUBLIC_*` is inlined at build time, not read at runtime.
 */
export const MEDIA_BASE_URL = (process.env.EXPO_PUBLIC_MEDIA_BASE_URL?.trim() || 'https://media.boardsesh.com').replace(
  /\/+$/,
  '',
);

/**
 * Which model version the app asks for when a caller does not say.
 *
 * A plain JS constant on purpose: it rides an OTA, so pointing the fleet at a
 * retrained model is a one-line change with no store release.
 *
 * It has to match a `--version` tag `ml/holds/publish_model.py` has actually
 * written. The tag shape is the dashed date in
 * `ml/holds/model-manifest.schema.json` ("a date tag (e.g. 2026-09-15)") — the
 * schema is the contract, and the README's example commands were corrected to
 * match it rather than the other way round. Nothing is published under it yet,
 * so today `ensureModel()` resolves null and the benchmark screen's version
 * field is how a tester reaches whatever is really in the bucket. Getting it
 * wrong costs a 404 and a null, never a crash.
 */
export const DEFAULT_MODEL_VERSION = process.env.EXPO_PUBLIC_HOLD_DETECTOR_VERSION?.trim() || '2026-09-15';

/** Cache subdirectory holding one directory per version. */
export const MODEL_CACHE_DIR = 'hold-detector';

/**
 * How many versions survive a sweep.
 *
 * Two, not one: a version change should not leave a climber who is mid-session
 * with no model at all while 31 MB downloads, and it should not need a second
 * download to roll back. Three would be 90 MB of cache for no extra safety.
 */
export const MAX_CACHED_VERSIONS = 2;

/** What a caller needs to open a session and decode its outputs. */
export interface ModelHandle {
  version: string;
  manifest: ModelManifest;
  /** Local path of the int8 weights, as `file://…`. */
  uri: string;
  /** The size the graph was TRAINED at — `runDetection`'s `size` may be smaller. */
  trainedInputSize: number;
  /** The score threshold this version ships, before any user slider. */
  defaultThreshold: number;
  /** Bytes on disk, as the manifest declared them. */
  bytes: number;
}

/**
 * Everything that touches the network or the filesystem, in one injectable
 * object, so the tests can drive the whole state machine without Expo native
 * modules.
 */
export interface ModelStoreIo {
  /** Parsed JSON body, or null for any transport or status failure. */
  fetchJson(url: string): Promise<unknown | null>;
  /** Download to `<cache>/hold-detector/<version>/<fileName>`; local uri, or null. */
  download(url: string, version: string, fileName: string): Promise<string | null>;
  /** Local uri of an already-present file, or null. */
  find(version: string, fileName: string): string | null;
  /** Streamed sha256 of a local file, or null when it cannot be read. */
  hashFile(uri: string): Promise<string | null>;
  /** Versions currently on disk, newest last-modified first. */
  listVersions(): string[];
  removeVersion(version: string): void;
}

function manifestUrl(version: string): string {
  return `${MEDIA_BASE_URL}/models/hold-detector/${encodeURIComponent(version)}/manifest.json`;
}

function weightsUrl(version: string, file: ModelManifestFile): string {
  const path = file.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${MEDIA_BASE_URL}/models/hold-detector/${encodeURIComponent(version)}/${path}`;
}

/** The last path segment of a manifest file entry — what it is stored as. */
function cacheFileName(file: ModelManifestFile): string {
  const segments = file.path.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? 'model.onnx';
}

/** Chunk size for the streamed hash. 1 MB is 31 reads for the nano export. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * How long a manifest fetch may hang before it is given up on, milliseconds.
 *
 * A stalled TCP connection — the captive-portal / one-bar-of-signal case — never
 * rejects on its own, and the benchmark screen shows a spinner with no cancel, so
 * without a deadline the only way out is to kill the app. Ten seconds for a JSON
 * file a few hundred bytes long is generous on any connection that works.
 */
export const MANIFEST_TIMEOUT_MS = 10_000;

/**
 * How long the weights download may hang, milliseconds.
 *
 * Longer than the manifest's because it is 31 MB: two minutes is about 2 Mbit/s,
 * below which the download is not worth waiting for on a gym's wifi. This is a
 * whole-transfer deadline, not an idle one — `File.downloadFileAsync` reports no
 * progress to race against.
 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Reject with a deadline the wrapped promise cannot see.
 *
 * `AbortSignal.timeout` is what aborts `fetch`; a download that does not take a
 * signal still needs a loser in the race, and this is it. The timer is always
 * cleared, so a resolved promise does not hold the event loop open for the rest
 * of the deadline (which in Hermes keeps the timer queue warm for two minutes).
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function modelDirectory(version: string): Directory {
  return new Directory(Paths.cache, MODEL_CACHE_DIR, version);
}

/** Modification time of the newest file directly inside a version directory, or 0. */
function newestFileMs(directory: Directory): number {
  try {
    let newest = 0;
    for (const entry of directory.list()) {
      if (entry instanceof Directory) continue;
      newest = Math.max(newest, entry.lastModified ?? 0);
    }
    return newest;
  } catch {
    return 0;
  }
}

/** The real IO, over `expo-file-system` and the platform `fetch`. */
export const expoModelStoreIo: ModelStoreIo = {
  async fetchJson(url) {
    try {
      // Both halves of the deadline: the signal is what actually tears the socket
      // down, and the race is what bounds this function even where the platform
      // fetch ignores a signal (the Expo WinterCG fetch has done exactly that).
      const response = await withDeadline(
        fetch(url, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) }),
        MANIFEST_TIMEOUT_MS,
        'Manifest fetch',
      );
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      // Offline, DNS failure, TLS failure, a body that is not JSON, or the
      // AbortError from the deadline above.
      return null;
    }
  },

  async download(url, version, fileName) {
    try {
      const directory = modelDirectory(version);
      if (!directory.exists) directory.create({ intermediates: true });
      const destination = new File(directory, fileName);
      // A half-written file from a killed download would otherwise be hashed as
      // if it were complete — and fail, which is correct but wastes the bytes.
      if (destination.exists) destination.delete();
      const downloaded = await withDeadline(
        File.downloadFileAsync(url, destination),
        DOWNLOAD_TIMEOUT_MS,
        'Model download',
      );
      return downloaded.uri;
    } catch {
      // A timed-out download leaves a partial file behind — and expo keeps
      // writing to it, since nothing here can cancel the native transfer. Delete
      // it so the next attempt re-downloads instead of hashing a truncated file.
      try {
        const partial = new File(modelDirectory(version), fileName);
        if (partial.exists) partial.delete();
      } catch {
        // Nothing to clean up, or a file the OS will not let us remove; the
        // sha256 check catches it either way.
      }
      return null;
    }
  },

  find(version, fileName) {
    try {
      const file = new File(modelDirectory(version), fileName);
      return file.exists ? file.uri : null;
    } catch {
      return null;
    }
  },

  async hashFile(uri) {
    let handle: { close(): void; readBytes(length: number): Uint8Array; size: number | null } | null = null;
    try {
      const file = new File(uri);
      if (!file.exists) return null;
      handle = file.open();
      const hash = new Sha256();
      for (;;) {
        const chunk = handle.readBytes(HASH_CHUNK_BYTES);
        if (chunk.length === 0) break;
        hash.update(chunk);
        // Hand the runtime back between megabytes. Hashing 31 MB in pure JS is
        // seconds of CPU; doing it in one synchronous run would freeze the UI
        // for all of them.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      return hash.digestHex();
    } catch {
      return null;
    } finally {
      handle?.close();
    }
  },

  listVersions() {
    try {
      const root = new Directory(Paths.cache, MODEL_CACHE_DIR);
      if (!root.exists) return [];
      return (
        root
          .list()
          .filter((entry): entry is Directory => entry instanceof Directory)
          // `Directory` has no `lastModified` (only `File` does), and a directory's
          // own mtime would not move when its contents are re-read anyway. The
          // newest file inside it is the honest recency signal.
          .map((entry) => ({ name: entry.name, modifiedAtMs: newestFileMs(entry) }))
          .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
          .map((entry) => entry.name)
      );
    } catch {
      return [];
    }
  },

  removeVersion(version) {
    try {
      const directory = modelDirectory(version);
      if (directory.exists) directory.delete();
    } catch {
      // A version we cannot delete is a version that stays; nothing downstream
      // depends on the sweep having succeeded.
    }
  },
};

/**
 * Delete every cached version except `keep` and the `MAX_CACHED_VERSIONS - 1`
 * most recently modified others. Returns what it removed.
 */
export function sweepModelVersions(io: ModelStoreIo, keep: string): string[] {
  const survivors = new Set<string>([keep]);
  for (const version of io.listVersions()) {
    if (survivors.size >= MAX_CACHED_VERSIONS) break;
    survivors.add(version);
  }
  const removed: string[] = [];
  for (const version of io.listVersions()) {
    if (survivors.has(version)) continue;
    io.removeVersion(version);
    removed.push(version);
  }
  return removed;
}

/**
 * `<version>@<sha256>` pairs this process has already hashed and matched.
 *
 * Deliberately in-process and never persisted. The sha256 is what stands between
 * a truncated download and an ONNX session that either throws deep in native
 * code or, worse, loads and emits noise — so it has to be paid once per launch,
 * on bytes this process has not seen. Paying it on EVERY call is ~31 MB of
 * streamed hashing for a file nothing has touched since the last call a second
 * ago. A cold start clears the set, which is exactly when the file could have
 * been truncated, replaced or half-reclaimed underneath us.
 *
 * Keyed on the digest as well as the version so a re-published manifest (the
 * manifest is the one mutable pointer) re-verifies rather than reusing a pass
 * recorded against different expected bytes.
 */
const verifiedThisProcess = new Set<string>();

/** Test seam: forget what this process has verified, as a cold start would. */
export function resetVerifiedModelCache(): void {
  verifiedThisProcess.clear();
}

export interface EnsureModelOptions {
  io?: ModelStoreIo;
  /** Called with 'manifest' | 'download' | 'verify' so a screen can say what is slow. */
  onStage?: (stage: 'manifest' | 'download' | 'verify') => void;
}

/**
 * The model for `version` (default `DEFAULT_MODEL_VERSION`), downloading and
 * verifying it if this device does not have it yet. Null when it cannot be had.
 */
export async function ensureModel(
  version: string = DEFAULT_MODEL_VERSION,
  options: EnsureModelOptions = {},
): Promise<ModelHandle | null> {
  const io = options.io ?? expoModelStoreIo;

  options.onStage?.('manifest');
  const manifest = parseModelManifest(await io.fetchJson(manifestUrl(version)));
  if (!manifest) return null;
  // A manifest that names a different version than the prefix it was served
  // from means the bucket has been edited by hand. Refuse rather than cache the
  // weights under a name that will not be found again.
  if (manifest.version !== version) return null;

  const file = selectInt8File(manifest);
  if (!file) return null;
  const fileName = cacheFileName(file);

  let uri = io.find(version, fileName);
  if (!uri) {
    options.onStage?.('download');
    uri = await io.download(weightsUrl(version, file), version, fileName);
    if (!uri) return null;
  }

  const verificationKey = `${version}@${file.sha256}`;
  if (!verifiedThisProcess.has(verificationKey)) {
    options.onStage?.('verify');
    const digest = await io.hashFile(uri);
    if (digest !== file.sha256) {
      io.removeVersion(version);
      return null;
    }
    verifiedThisProcess.add(verificationKey);
  }

  sweepModelVersions(io, version);

  return {
    version,
    manifest,
    uri,
    trainedInputSize: manifest.input.width,
    defaultThreshold: manifest.thresholds.default,
    bytes: file.bytes,
  };
}
