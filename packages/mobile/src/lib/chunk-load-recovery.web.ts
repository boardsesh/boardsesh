// WEB FORK — recovery for a route chunk that failed to load (#5611).
//
// app.boardsesh.com splits every route into its own content-hashed chunk
// (`asyncRoutes`, #5467), and Cloudflare Pages serves only the current
// deployment's files. A tab opened before a deploy still holds the old entry's
// chunk map, so the first navigation to a route it has not loaded yet asks for a
// file that is now a 404. In the week after #5467 that was 9 of 11 production
// AsyncRequireErrors; the other two were chunks that were live but did not arrive
// (in-app browsers on flaky networks).
//
// Nothing inside the tab can recover either case. Expo Router wraps each route in
// `React.lazy`, and React keeps a rejected lazy component rejected for the life of
// the page, so "Try again" re-throws and "Go home" asks for another stale chunk.
// A full page load fetches the current `index.html`, whose entry carries the
// current chunk map. So the recovery is a reload, bounded so it cannot loop:
//
//   - at most one automatic reload per tab per CHUNK_RELOAD_WINDOW_MS, tracked in
//     sessionStorage (survives the reload, scoped to the tab);
//   - no automatic reload while the browser reports itself offline, or when the
//     origin does not answer a probe — a reload then lands on the browser's own
//     offline page and loses the app entirely;
//   - no automatic reload when sessionStorage is unavailable (private modes,
//     some in-app browsers): without the guard a reload could repeat forever.
//
// Every non-reload outcome leaves the climber a manual Reload button.
//
// The inline script in `public/index.html` covers the one failure this module
// cannot: the root `_layout` chunk itself, which holds the error boundary that
// calls in here. It shares CHUNK_RELOAD_GUARD_KEY and CHUNK_RELOAD_WINDOW_MS, so
// the two paths together still reload at most once per window.

import { reportError } from './error-reporting';
import { flushSentry } from './sentry';

export type ChunkLoadCause = 'stale-deploy' | 'transient' | 'network' | 'offline';

/** What the recovery did: reloaded the page, or left a manual Reload button. */
export type ChunkRecoveryOutcome = 'reloading' | 'offline' | 'exhausted';

/** sessionStorage key holding the time of the last automatic reload. Read by `public/index.html` too. */
export const CHUNK_RELOAD_GUARD_KEY = 'boardsesh:chunk-reload-at';

/** Minimum gap between two automatic reloads in one tab. Read by `public/index.html` too. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

/** How long the status probe may take before the failure counts as a network one. */
const PROBE_TIMEOUT_MS = 3_000;

/** How long a report gets to leave before the reload tears the page down. */
const FLUSH_TIMEOUT_MS = 2_000;

const CHUNK_FAILURE_MESSAGE = /^Loading module (\S+) failed\./;

type ChunkLoadErrorShape = { name?: unknown; message?: unknown; request?: unknown };

/**
 * An `AsyncRequireError` from Expo's web chunk loader
 * (`expo/src/async-require/fetchThenEval.web.ts`). Matched on the class name,
 * with the loader's fixed message as a fallback in case minification renames it.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as ChunkLoadErrorShape;
  if (name === 'AsyncRequireError') return true;
  return typeof message === 'string' && CHUNK_FAILURE_MESSAGE.test(message);
}

/** The chunk URL the loader failed on, or null when the error does not carry one. */
export function readChunkUrl(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { request, message } = error as ChunkLoadErrorShape;
  if (typeof request === 'string' && request) return request;
  if (typeof message !== 'string') return null;
  return CHUNK_FAILURE_MESSAGE.exec(message)?.[1] ?? null;
}

/**
 * Classify a failed chunk by asking the origin for it again. A `<script>` error
 * carries no HTTP status, so this probe is the only way to tell a deploy that
 * removed the file (404) from a load that simply did not arrive.
 */
export async function probeChunk(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ cause: Exclude<ChunkLoadCause, 'offline'>; status: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
    return { cause: response.status === 404 ? 'stale-deploy' : 'transient', status: response.status };
  } catch {
    return { cause: 'network', status: null };
  } finally {
    clearTimeout(timer);
  }
}

type GuardStorage = Pick<Storage, 'getItem' | 'setItem'>;

function tabStorage(): GuardStorage | null {
  try {
    // oxlint-disable-next-line no-restricted-globals -- tab-scoped reload guard; must be synchronous and survive the reload (#5611)
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Take this tab's one automatic reload for the current window. Returns false if
 * the window's reload is already spent — or if storage cannot be read or
 * written, because a reload whose guard did not stick is a reload that can loop.
 */
export function claimAutoReload(storage: GuardStorage | null, now: number): boolean {
  if (!storage) return false;
  try {
    const lastReloadAt = Number(storage.getItem(CHUNK_RELOAD_GUARD_KEY));
    if (lastReloadAt > 0 && now - lastReloadAt < CHUNK_RELOAD_WINDOW_MS) return false;
    storage.setItem(CHUNK_RELOAD_GUARD_KEY, String(now));
    return storage.getItem(CHUNK_RELOAD_GUARD_KEY) === String(now);
  } catch {
    return false;
  }
}

/** The entry bundle this tab booted from — the deployment it belongs to. */
function readEntryBundle(): string | null {
  const entryScript = document.querySelector<HTMLScriptElement>('script[src*="/entry-"]');
  if (!entryScript) return null;
  return entryScript.src.slice(entryScript.src.lastIndexOf('/') + 1);
}

async function flushWithDeadline(): Promise<void> {
  await Promise.race([
    flushSentry().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ]);
}

export type ChunkRecoveryDeps = {
  isOnline: () => boolean;
  fetchImpl: typeof fetch;
  storage: () => GuardStorage | null;
  now: () => number;
  report: typeof reportError;
  flush: () => Promise<void>;
  reload: () => void;
  entryBundle: () => string | null;
};

const browserDeps: ChunkRecoveryDeps = {
  isOnline: () => navigator.onLine !== false,
  fetchImpl: (input, init) => fetch(input, init),
  storage: tabStorage,
  now: () => Date.now(),
  report: reportError,
  flush: flushWithDeadline,
  reload: () => window.location.reload(),
  entryBundle: readEntryBundle,
};

/**
 * Report the failed chunk with its cause, then reload once if that can help.
 * Resolves to what happened so the error screen can say so.
 */
export async function recoverFromChunkLoadError(
  error: unknown,
  deps: ChunkRecoveryDeps = browserDeps,
): Promise<ChunkRecoveryOutcome> {
  const chunkUrl = readChunkUrl(error);
  const online = deps.isOnline();
  const probe = online && chunkUrl ? await probeChunk(chunkUrl, deps.fetchImpl) : null;
  const cause: ChunkLoadCause = !online ? 'offline' : (probe?.cause ?? 'transient');

  const outcome: ChunkRecoveryOutcome =
    cause === 'offline' || cause === 'network'
      ? 'offline'
      : claimAutoReload(deps.storage(), deps.now())
        ? 'reloading'
        : 'exhausted';

  deps.report(error, {
    tags: { chunk_load_cause: cause, chunk_load_recovery: outcome },
    extra: { chunkUrl, httpStatus: probe?.status ?? null, entryBundle: deps.entryBundle() },
    // Group by mechanism, not by the hashed chunk filename in the message, so
    // every deploy's stale chunks land in one issue per cause.
    fingerprint: ['chunk-load-error', cause],
  });

  if (outcome === 'reloading') {
    await deps.flush();
    deps.reload();
  }
  return outcome;
}

/** The manual Reload button. Always allowed: the climber asked for it. */
export function reloadPage(): void {
  window.location.reload();
}
