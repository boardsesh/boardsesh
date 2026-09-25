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

/**
 * Run the shell script with the browser globals it touches swapped for
 * controllable ones (jsdom's own `location.reload` cannot be observed).
 */
function bootShell({
  online = true,
  storage = window.sessionStorage as Pick<Storage, 'getItem' | 'setItem'>,
  now = 10_000_000,
} = {}) {
  let listener: RejectionListener | null = null;
  const reload = vi.fn();
  const fakeWindow: ShellWindow = {
    addEventListener: (type, handler) => {
      if (type === 'unhandledrejection') listener = handler;
    },
    location: { reload },
  };
  // A fresh VM context holding only the globals the script touches, so it runs
  // exactly as shipped, text unchanged.
  runInNewContext(extractRecoveryScript(), {
    window: fakeWindow,
    document,
    navigator: { onLine: online },
    sessionStorage: storage,
    Date: { now: () => now },
  });
  return {
    reload,
    window: fakeWindow,
    reject: (reason: unknown) => {
      if (!listener) throw new Error('script installed no unhandledrejection listener');
      listener({ reason });
    },
  };
}

const chunkError = {
  name: 'AsyncRequireError',
  message: 'Loading module https://app.boardsesh.com/_layout-1.js failed.',
};

function failurePanel() {
  return document.getElementById('boot-failure');
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

  it('flag unset: reloads once when a chunk fails before the root layout loaded', () => {
    const shell = bootShell();
    shell.reject(chunkError);
    expect(shell.reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBe('10000000');
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY)).toBe('1');
  });

  it('flag unset: reloads even when React already put its own markup in #root', () => {
    // The old "#root is empty or still holds the boot paint" heuristic gave up
    // here; the flag does not care what React committed.
    document.body.innerHTML = '<div id="root"><div class="suspense-fallback"></div></div>';
    const shell = bootShell();
    shell.reject(chunkError);
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  it('flag set: stands down, because the root error boundary owns the failure', () => {
    const shell = bootShell();
    shell.window[ROOT_LAYOUT_LOADED_FLAG] = true;

    shell.reject(chunkError);

    expect(shell.reload).not.toHaveBeenCalled();
    expect(failurePanel()).toBeNull();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY)).toBeNull();
  });

  it('does not reload again inside the window, and paints a Reload button beside #root', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(10_000_000 - CHUNK_RELOAD_WINDOW_MS + 1));
    const shell = bootShell();

    shell.reject(chunkError);

    expect(shell.reload).not.toHaveBeenCalled();
    const panel = failurePanel();
    expect(panel?.parentElement).toBe(document.body);
    expect(document.getElementById('boot-paint')).not.toBeNull();
    expect(panel?.querySelector('p')?.textContent).toBe("Boardsesh didn't load. Reload to try again.");
    const button = panel?.querySelector('button');
    expect(button?.textContent).toBe('Reload');
    button?.click();
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  it('stops after three automatic reloads in one tab, however far apart', () => {
    let now = 10_000_000;
    for (let reload = 1; reload <= CHUNK_RELOAD_MAX_PER_TAB; reload += 1) {
      const shell = bootShell({ now });
      shell.reject(chunkError);
      expect(shell.reload).toHaveBeenCalledTimes(1);
      now += CHUNK_RELOAD_WINDOW_MS * 5;
    }
    expect(CHUNK_RELOAD_MAX_PER_TAB).toBe(3);

    const exhausted = bootShell({ now: now + CHUNK_RELOAD_WINDOW_MS * 100 });
    exhausted.reject(chunkError);

    expect(exhausted.reload).not.toHaveBeenCalled();
    expect(failurePanel()?.querySelector('button')).not.toBeNull();
  });

  it('never reloads while offline', () => {
    const shell = bootShell({ online: false });
    shell.reject(chunkError);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(failurePanel()?.querySelector('p')?.textContent).toBe("You're offline. Reconnect, then reload.");
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBeNull();
  });

  it('does not reload when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => undefined,
    };
    const shell = bootShell({ storage: blocked });
    shell.reject(chunkError);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(failurePanel()?.querySelector('button')).not.toBeNull();
  });

  it('paints one panel however many chunks fail', () => {
    const shell = bootShell({ online: false });
    shell.reject(chunkError);
    shell.reject(chunkError);
    expect(document.querySelectorAll('#boot-failure')).toHaveLength(1);
  });

  it('ignores rejections that are not chunk failures', () => {
    const shell = bootShell();
    shell.reject(new Error('GraphQL down'));
    shell.reject(undefined);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(failurePanel()).toBeNull();
  });
});
