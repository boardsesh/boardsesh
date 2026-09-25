// @vitest-environment jsdom
//
// The inline script in public/index.html recovers the one chunk failure the
// root error boundary cannot: the root `_layout` chunk itself (#5611). It runs
// before any bundle, so it cannot import the guard from
// src/lib/chunk-load-recovery.web.ts; this suite executes the shipped script
// against a DOM and pins it to that module's keys, limits and flag.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../lib/sentry', () => ({ flushSentry: vi.fn().mockResolvedValue(true) }));

import {
  CHUNK_RELOAD_COUNT_KEY,
  CHUNK_RELOAD_GUARD_KEY,
  CHUNK_RELOAD_MAX_PER_TAB,
  CHUNK_RELOAD_WINDOW_MS,
  ROOT_LAYOUT_LOADED_FLAG,
} from '../lib/chunk-load-recovery.web';

// jsdom replaces the global URL, which readFileSync does not accept; go via a path.
const shellSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

function extractRecoveryScript(): string {
  const scripts = [...shellSource.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const recovery = scripts.filter((script) => script.includes('unhandledrejection'));
  expect(recovery).toHaveLength(1);
  return recovery[0];
}

const BOOT_PAINT = '<div id="root"><div id="boot-paint"><b>Boardsesh</b><i></i></div></div>';

type RejectionListener = (event: { reason: unknown }) => void;
type ShellWindow = {
  addEventListener: (type: string, handler: RejectionListener) => void;
  location: { reload: () => void };
  [ROOT_LAYOUT_LOADED_FLAG]?: boolean;
};

type ProbeBehaviour = 'answer-404' | 'answer-200' | 'no-answer' | 'hang' | 'no-fetch';

/**
 * Run the shell script with the browser globals it touches swapped for
 * controllable ones (jsdom's own `location.reload` cannot be observed).
 */
function bootShell({
  online = true,
  storage = window.sessionStorage as Pick<Storage, 'getItem' | 'setItem'>,
  now = 10_000_000,
  probe = 'answer-404' as ProbeBehaviour,
} = {}) {
  let listener: RejectionListener | null = null;
  const reload = vi.fn();
  const fakeWindow: ShellWindow = {
    addEventListener: (type, handler) => {
      if (type === 'unhandledrejection') listener = handler;
    },
    location: { reload },
  };
  const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => {
    if (probe === 'answer-404') return Promise.resolve(new Response(null, { status: 404 }));
    if (probe === 'answer-200') return Promise.resolve(new Response(null, { status: 200 }));
    if (probe === 'no-answer') return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise<Response>(() => {});
  });
  const timers: Array<() => void> = [];
  // A fresh VM context holding only the globals the script touches, so it runs
  // exactly as shipped, text unchanged.
  runInNewContext(extractRecoveryScript(), {
    window: fakeWindow,
    document,
    navigator: { onLine: online },
    sessionStorage: storage,
    Date: { now: () => now },
    fetch: probe === 'no-fetch' ? undefined : fetchImpl,
    AbortController,
    setTimeout: (callback: () => void) => timers.push(callback),
  });
  return {
    reload,
    fetchImpl,
    window: fakeWindow,
    /** Fire the probe timeout the script scheduled. */
    expireProbe: () => timers.splice(0).forEach((callback) => callback()),
    /** Deliver a rejection and let the probe's promise settle. */
    reject: async (reason: unknown) => {
      if (!listener) throw new Error('script installed no unhandledrejection listener');
      listener({ reason });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const CHUNK_URL = 'https://app.boardsesh.com/_expo/static/js/web/_layout-1.js';
const chunkError = {
  name: 'AsyncRequireError',
  message: `Loading module ${CHUNK_URL} failed.\n(error: ${CHUNK_URL})`,
};

function failurePanel() {
  return document.getElementById('boot-failure');
}

function panelMessage() {
  return failurePanel()?.querySelector('p')?.textContent;
}

beforeEach(() => {
  document.body.innerHTML = BOOT_PAINT;
  window.sessionStorage.clear();
});

describe('shell root-layout chunk recovery', () => {
  it('shares the guard keys, limits and flag with chunk-load-recovery.web.ts', () => {
    const script = extractRecoveryScript();
    expect(script).toContain(`'${CHUNK_RELOAD_GUARD_KEY}'`);
    expect(script).toContain(`'${CHUNK_RELOAD_COUNT_KEY}'`);
    expect(script).toContain(`WINDOW_MS = ${CHUNK_RELOAD_WINDOW_MS};`);
    expect(script).toContain(`MAX_PER_TAB = ${CHUNK_RELOAD_MAX_PER_TAB};`);
    expect(script).toContain(`window.${ROOT_LAYOUT_LOADED_FLAG} === true`);
  });

  it('stays ES5, since old in-app browsers run it before any polyfill', () => {
    // The formatter rewrites inline scripts too, and its trailing comma in a
    // multi-line call is an ES2017 syntax error that would kill the listener.
    const code = extractRecoveryScript()
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
    for (const [label, pattern] of [
      ['arrow function', /=>/],
      ['let/const', /\b(?:let|const)\s/],
      ['template literal', /`/],
      ['async/await', /\b(?:async|await)\b/],
      ['class', /\bclass\s/],
      ['spread/rest', /\.\.\./],
      ['trailing comma in a call', /,\s*\)/],
    ] as const) {
      expect(code, `inline recovery script uses ${label}`).not.toMatch(pattern);
    }
  });

  it('probes the failed chunk with an uncached HEAD before deciding', async () => {
    const shell = bootShell();
    await shell.reject(chunkError);
    expect(shell.fetchImpl).toHaveBeenCalledTimes(1);
    expect(shell.fetchImpl).toHaveBeenCalledWith(
      CHUNK_URL,
      expect.objectContaining({ method: 'HEAD', cache: 'no-store' }),
    );
  });

  it('flag unset, probe answers 404: reloads once', async () => {
    const shell = bootShell({ probe: 'answer-404' });
    await shell.reject(chunkError);
    expect(shell.reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBe('10000000');
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY)).toBe('1');
  });

  it('flag unset, live chunk that did not arrive (200): reloads once', async () => {
    const shell = bootShell({ probe: 'answer-200' });
    await shell.reject(chunkError);
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  it('probe gets no answer: keeps the shell, shows Reload, spends no guard', async () => {
    const shell = bootShell({ probe: 'no-answer' });
    await shell.reject(chunkError);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(panelMessage()).toBe("Couldn't reach Boardsesh. Check your connection, then reload.");
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY)).toBeNull();
  });

  it('probe hangs past its timeout: same as no answer', async () => {
    const shell = bootShell({ probe: 'hang' });
    await shell.reject(chunkError);
    expect(shell.reload).not.toHaveBeenCalled();
    shell.expireProbe();
    expect(shell.reload).not.toHaveBeenCalled();
    expect(panelMessage()).toBe("Couldn't reach Boardsesh. Check your connection, then reload.");
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY)).toBeNull();
  });

  it('no chunk URL to probe, or no fetch: does not reload blind', async () => {
    const noUrl = bootShell();
    await noUrl.reject({ name: 'AsyncRequireError', message: 'something else' });
    expect(noUrl.fetchImpl).not.toHaveBeenCalled();
    expect(noUrl.reload).not.toHaveBeenCalled();
    expect(panelMessage()).toBe("Couldn't reach Boardsesh. Check your connection, then reload.");

    document.body.innerHTML = BOOT_PAINT;
    const noFetch = bootShell({ probe: 'no-fetch' });
    await noFetch.reject(chunkError);
    expect(noFetch.reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY)).toBeNull();
  });

  it('flag unset: reloads even when React already put its own markup in #root', async () => {
    // The old "#root is empty or still holds the boot paint" heuristic gave up
    // here; the flag does not care what React committed.
    document.body.innerHTML = '<div id="root"><div class="suspense-fallback"></div></div>';
    const shell = bootShell();
    await shell.reject(chunkError);
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  it('flag set: stands down, because the root error boundary owns the failure', async () => {
    const shell = bootShell();
    shell.window[ROOT_LAYOUT_LOADED_FLAG] = true;

    await shell.reject(chunkError);

    expect(shell.fetchImpl).not.toHaveBeenCalled();
    expect(shell.reload).not.toHaveBeenCalled();
    expect(failurePanel()).toBeNull();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY)).toBeNull();
  });

  it('one probe answers for several layout chunks failing together', async () => {
    const shell = bootShell({ probe: 'hang' });
    await shell.reject(chunkError);
    await shell.reject(chunkError);
    await shell.reject(chunkError);
    expect(shell.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not reload again inside the window, and paints a Reload button beside #root', async () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(10_000_000 - CHUNK_RELOAD_WINDOW_MS + 1));
    const shell = bootShell();

    await shell.reject(chunkError);

    expect(shell.reload).not.toHaveBeenCalled();
    const panel = failurePanel();
    expect(panel?.parentElement).toBe(document.body);
    expect(document.getElementById('boot-paint')).not.toBeNull();
    expect(panelMessage()).toBe("Boardsesh didn't load. Reload to try again.");
    const button = panel?.querySelector('button');
    expect(button?.textContent).toBe('Reload');
    button?.click();
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  it('stops after three automatic reloads in one tab, however far apart', async () => {
    let now = 10_000_000;
    for (let reload = 1; reload <= CHUNK_RELOAD_MAX_PER_TAB; reload += 1) {
      const shell = bootShell({ now });
      await shell.reject(chunkError);
      expect(shell.reload).toHaveBeenCalledTimes(1);
      now += CHUNK_RELOAD_WINDOW_MS * 5;
    }
    expect(CHUNK_RELOAD_MAX_PER_TAB).toBe(3);

    const exhausted = bootShell({ now: now + CHUNK_RELOAD_WINDOW_MS * 100 });
    await exhausted.reject(chunkError);

    expect(exhausted.reload).not.toHaveBeenCalled();
    expect(failurePanel()?.querySelector('button')).not.toBeNull();
  });

  it('never reloads or probes while offline', async () => {
    const shell = bootShell({ online: false });
    await shell.reject(chunkError);
    expect(shell.fetchImpl).not.toHaveBeenCalled();
    expect(shell.reload).not.toHaveBeenCalled();
    expect(panelMessage()).toBe("You're offline. Reconnect, then reload.");
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBeNull();
  });

  it('does not reload when storage is blocked', async () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => undefined,
    };
    const shell = bootShell({ storage: blocked });
    await shell.reject(chunkError);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(failurePanel()?.querySelector('button')).not.toBeNull();
  });

  it('paints one panel however many chunks fail', async () => {
    const shell = bootShell({ online: false });
    await shell.reject(chunkError);
    await shell.reject(chunkError);
    expect(document.querySelectorAll('#boot-failure')).toHaveLength(1);
  });

  it('ignores rejections that are not chunk failures', async () => {
    const shell = bootShell();
    await shell.reject(new Error('GraphQL down'));
    await shell.reject(undefined);
    expect(shell.fetchImpl).not.toHaveBeenCalled();
    expect(shell.reload).not.toHaveBeenCalled();
    expect(failurePanel()).toBeNull();
  });
});
