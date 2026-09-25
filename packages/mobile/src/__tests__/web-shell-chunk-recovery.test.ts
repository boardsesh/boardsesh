// @vitest-environment jsdom
//
// The inline script in public/index.html recovers the one chunk failure the
// root error boundary cannot: the root `_layout` chunk itself (#5611). It runs
// before any bundle, so it cannot import the guard from
// src/lib/chunk-load-recovery.web.ts; this suite executes the shipped script
// against a DOM and pins it to that module's key and window.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../lib/sentry', () => ({ flushSentry: vi.fn().mockResolvedValue(true) }));

import { CHUNK_RELOAD_GUARD_KEY, CHUNK_RELOAD_WINDOW_MS } from '../lib/chunk-load-recovery.web';

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
  const fakeWindow = {
    addEventListener: (type: string, handler: RejectionListener) => {
      if (type === 'unhandledrejection') listener = handler;
    },
    location: { reload },
  };
  const fakeDate = { now: () => now };
  // A fresh VM context holding only the globals the script touches, so it runs
  // exactly as shipped, text unchanged.
  runInNewContext(extractRecoveryScript(), {
    window: fakeWindow,
    document,
    navigator: { onLine: online },
    sessionStorage: storage,
    Date: fakeDate,
  });
  return {
    reload,
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

beforeEach(() => {
  document.body.innerHTML = BOOT_PAINT;
  window.sessionStorage.clear();
});

describe('shell root-layout chunk recovery', () => {
  it('shares the guard key and window with chunk-load-recovery.web.ts', () => {
    const script = extractRecoveryScript();
    expect(script).toContain(`'${CHUNK_RELOAD_GUARD_KEY}'`);
    expect(script).toContain(`WINDOW_MS = ${CHUNK_RELOAD_WINDOW_MS};`);
  });

  it('reloads once when the root layout chunk fails before the app mounts', () => {
    const shell = bootShell();
    shell.reject(chunkError);
    expect(shell.reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBe('10000000');
  });

  it('does not reload again inside the window, and paints a Reload button', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(10_000_000 - CHUNK_RELOAD_WINDOW_MS + 1));
    const shell = bootShell();

    shell.reject(chunkError);

    expect(shell.reload).not.toHaveBeenCalled();
    expect(document.querySelector('#boot-paint p')?.textContent).toBe("Boardsesh didn't load. Reload to try again.");
    const button = document.querySelector<HTMLButtonElement>('#boot-paint button');
    expect(button?.textContent).toBe('Reload');
    button?.click();
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads while offline', () => {
    const shell = bootShell({ online: false });
    shell.reject(chunkError);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(document.querySelector('#boot-paint p')?.textContent).toBe("You're offline. Reconnect, then reload.");
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
    expect(document.querySelector('#boot-paint button')).not.toBeNull();
  });

  it('recovers when React already cleared the boot paint and rendered nothing', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const shell = bootShell();
    shell.reject(chunkError);
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves a mounted app alone: the root error boundary owns that failure', () => {
    document.body.innerHTML = '<div id="root"><div class="app">climbs</div></div>';
    const shell = bootShell();
    shell.reject(chunkError);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(document.querySelector('.app')?.textContent).toBe('climbs');
  });

  it('ignores rejections that are not chunk failures', () => {
    const shell = bootShell();
    shell.reject(new Error('GraphQL down'));
    shell.reject(undefined);
    expect(shell.reload).not.toHaveBeenCalled();
    expect(document.querySelector('#boot-paint i')).not.toBeNull();
  });
});
