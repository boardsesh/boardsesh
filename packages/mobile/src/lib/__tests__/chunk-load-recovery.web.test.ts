// @vitest-environment jsdom
//
// The web fork, imported by its explicit `.web` path — vitest resolves the bare
// specifier to the native fork, so this suite is the only thing that exercises
// the recovery app.boardsesh.com actually runs (#5611).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../sentry', () => ({ flushSentry: vi.fn().mockResolvedValue(true) }));

import {
  CHUNK_RELOAD_COUNT_KEY,
  CHUNK_RELOAD_GUARD_KEY,
  CHUNK_RELOAD_MAX_PER_TAB,
  CHUNK_RELOAD_WINDOW_MS,
  ROOT_LAYOUT_LOADED_FLAG,
  claimAutoReload,
  markRootLayoutLoaded,
  isChunkLoadError,
  probeChunk,
  readChunkUrl,
  recoverFromChunkLoadError,
  type ChunkRecoveryDeps,
} from '../chunk-load-recovery.web';

const CHUNK_URL = 'https://app.boardsesh.com/_expo/static/js/web/index-f892f7872f81f68707217e9db9d34174.js';

/** The exact shape Expo's web loader rejects with (expo/src/async-require/fetchThenEval.web.ts). */
function asyncRequireError(url = CHUNK_URL): Error {
  const error = new Error(`Loading module ${url} failed.\n(error: ${url})`) as Error & {
    request?: string;
    type?: string;
  };
  Object.defineProperty(error, 'name', { value: 'AsyncRequireError' });
  error.request = url;
  error.type = 'error';
  return error;
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function statusResponse(status: number): Response {
  return new Response(null, { status });
}

function makeDeps(overrides: Partial<ChunkRecoveryDeps> = {}) {
  const storage = memoryStorage();
  const calls: string[] = [];
  const deps: ChunkRecoveryDeps = {
    isOnline: () => true,
    fetchImpl: vi.fn().mockResolvedValue(statusResponse(404)),
    storage: () => storage,
    now: () => 1_000_000,
    report: vi.fn(() => void calls.push('report')),
    flush: vi.fn(async () => void calls.push('flush')),
    reload: vi.fn(() => void calls.push('reload')),
    entryBundle: () => 'entry-c9ee759f03c1887b7788c8bc2fc03324.js',
    ...overrides,
  };
  return { deps, storage, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isChunkLoadError', () => {
  it('matches the AsyncRequireError Expo rejects a failed chunk with', () => {
    expect(isChunkLoadError(asyncRequireError())).toBe(true);
  });

  it('matches on the fixed loader message if minification renamed the class', () => {
    expect(isChunkLoadError(new Error(`Loading module ${CHUNK_URL} failed.\n(error: ${CHUNK_URL})`))).toBe(true);
  });

  it.each([new Error('boom'), new TypeError('Failed to fetch'), null, undefined, 'Loading module x failed.'])(
    'ignores %s',
    (value) => {
      expect(isChunkLoadError(value)).toBe(false);
    },
  );
});

describe('readChunkUrl', () => {
  it('reads the request the loader recorded', () => {
    expect(readChunkUrl(asyncRequireError())).toBe(CHUNK_URL);
  });

  it('falls back to the URL in the message', () => {
    expect(readChunkUrl(new Error(`Loading module ${CHUNK_URL} failed.`))).toBe(CHUNK_URL);
  });

  it('returns null when there is no URL to read', () => {
    expect(readChunkUrl(new Error('boom'))).toBeNull();
  });
});

describe('probeChunk', () => {
  it('reads a 404 as a deploy that removed the chunk', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(404));
    await expect(probeChunk(CHUNK_URL, fetchImpl)).resolves.toEqual({ cause: 'stale-deploy', status: 404 });
    expect(fetchImpl).toHaveBeenCalledWith(CHUNK_URL, expect.objectContaining({ method: 'HEAD', cache: 'no-store' }));
  });

  it('reads a live chunk as a load that did not arrive', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(200));
    await expect(probeChunk(CHUNK_URL, fetchImpl)).resolves.toEqual({ cause: 'transient', status: 200 });
  });

  it('reads a probe that cannot reach the origin as a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(probeChunk(CHUNK_URL, fetchImpl)).resolves.toEqual({ cause: 'network', status: null });
  });

  it('gives up after its timeout instead of hanging the error screen', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const probe = probeChunk(CHUNK_URL, fetchImpl as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(probe).resolves.toEqual({ cause: 'network', status: null });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('claimAutoReload', () => {
  it('grants one reload per window and records when', () => {
    const storage = memoryStorage();
    expect(claimAutoReload(storage, 1_000_000)).toBe(true);
    expect(storage.values.get(CHUNK_RELOAD_GUARD_KEY)).toBe('1000000');
    expect(claimAutoReload(storage, 1_000_000 + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false);
  });

  it('grants the next reload once the window has passed', () => {
    const storage = memoryStorage();
    expect(claimAutoReload(storage, 1_000_000)).toBe(true);
    expect(claimAutoReload(storage, 1_000_000 + CHUNK_RELOAD_WINDOW_MS)).toBe(true);
  });

  it('stops for good after three reloads in one tab, however far apart', () => {
    // A network that stalls every chunk past the window would otherwise reload
    // the tab once a minute for as long as it stays open.
    const storage = memoryStorage();
    let now = 1_000_000;
    for (let reload = 1; reload <= CHUNK_RELOAD_MAX_PER_TAB; reload += 1) {
      expect(claimAutoReload(storage, now)).toBe(true);
      expect(storage.values.get(CHUNK_RELOAD_COUNT_KEY)).toBe(String(reload));
      now += CHUNK_RELOAD_WINDOW_MS * 10;
    }
    expect(CHUNK_RELOAD_MAX_PER_TAB).toBe(3);
    expect(claimAutoReload(storage, now)).toBe(false);
    expect(claimAutoReload(storage, now + CHUNK_RELOAD_WINDOW_MS * 100)).toBe(false);
  });

  it('refuses without storage, because an unguarded reload can loop', () => {
    expect(claimAutoReload(null, 1_000_000)).toBe(false);
  });

  it('refuses when storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => undefined,
    };
    expect(claimAutoReload(throwing, 1_000_000)).toBe(false);
  });

  it('refuses when the write silently does not stick', () => {
    const forgetful = { getItem: () => null, setItem: () => undefined };
    expect(claimAutoReload(forgetful, 1_000_000)).toBe(false);
  });

  it("works against the browser's real sessionStorage", () => {
    window.sessionStorage.clear();
    expect(claimAutoReload(window.sessionStorage, 5_000_000)).toBe(true);
    expect(claimAutoReload(window.sessionStorage, 5_000_001)).toBe(false);
    window.sessionStorage.clear();
  });
});

describe('markRootLayoutLoaded', () => {
  it('raises the flag the shell script stands down on, and clears its panel', () => {
    const flags = window as unknown as Record<string, unknown>;
    delete flags[ROOT_LAYOUT_LOADED_FLAG];
    document.body.innerHTML = '<div id="root"></div><div id="boot-failure">Reload</div>';

    markRootLayoutLoaded();

    expect(flags[ROOT_LAYOUT_LOADED_FLAG]).toBe(true);
    expect(document.getElementById('boot-failure')).toBeNull();
    expect(document.getElementById('root')).not.toBeNull();
    delete flags[ROOT_LAYOUT_LOADED_FLAG];
  });
});

describe('recoverFromChunkLoadError', () => {
  it('reports a stale-deploy chunk, flushes, then reloads once', async () => {
    const { deps, calls } = makeDeps();

    await expect(recoverFromChunkLoadError(asyncRequireError(), deps)).resolves.toBe('reloading');

    expect(calls).toEqual(['report', 'flush', 'reload']);
    expect(deps.report).toHaveBeenCalledWith(expect.any(Error), {
      tags: { chunk_load_cause: 'stale-deploy', chunk_load_recovery: 'reloading' },
      extra: { chunkUrl: CHUNK_URL, httpStatus: 404, entryBundle: 'entry-c9ee759f03c1887b7788c8bc2fc03324.js' },
      fingerprint: ['chunk-load-error', 'stale-deploy'],
    });
  });

  it('reloads for a live chunk that did not arrive too', async () => {
    const { deps } = makeDeps({ fetchImpl: vi.fn().mockResolvedValue(statusResponse(200)) });
    await expect(recoverFromChunkLoadError(asyncRequireError(), deps)).resolves.toBe('reloading');
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a second time inside the window — the loop guard', async () => {
    const { deps } = makeDeps();

    await recoverFromChunkLoadError(asyncRequireError(), deps);
    // The reloaded page fails again straight away (say the CDN is still stale).
    await expect(recoverFromChunkLoadError(asyncRequireError(), deps)).resolves.toBe('exhausted');

    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads while the browser is offline, and does not probe', async () => {
    const { deps } = makeDeps({ isOnline: () => false });

    await expect(recoverFromChunkLoadError(asyncRequireError(), deps)).resolves.toBe('offline');

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { chunk_load_cause: 'offline', chunk_load_recovery: 'offline' } }),
    );
  });

  it('does not reload when the origin does not answer the probe', async () => {
    const { deps, storage } = makeDeps({ fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });

    await expect(recoverFromChunkLoadError(asyncRequireError(), deps)).resolves.toBe('offline');

    expect(deps.reload).not.toHaveBeenCalled();
    // The window's one reload is still unspent for when the network comes back.
    expect(storage.values.has(CHUNK_RELOAD_GUARD_KEY)).toBe(false);
  });

  it('stops auto-reloading after the per-tab cap, leaving the manual button', async () => {
    const { deps, storage } = makeDeps();
    storage.values.set(CHUNK_RELOAD_COUNT_KEY, String(CHUNK_RELOAD_MAX_PER_TAB));
    await expect(recoverFromChunkLoadError(asyncRequireError(), deps)).resolves.toBe('exhausted');
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('does not reload when storage is blocked', async () => {
    const { deps } = makeDeps({ storage: () => null });
    await expect(recoverFromChunkLoadError(asyncRequireError(), deps)).resolves.toBe('exhausted');
    expect(deps.reload).not.toHaveBeenCalled();
  });
});
