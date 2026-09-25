import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../sentry', () => ({ flushSentry: vi.fn().mockResolvedValue(true) }));

import * as nativeFork from '../chunk-load-recovery';
import * as webFork from '../chunk-load-recovery.web';

// The bare specifier resolves to the native fork here, exactly as Metro does
// for iOS and Android. Every merge touching packages/mobile ships an OTA to the
// store fleet, so this fork must stay a constant module (#5611).

const nativeSource = readFileSync(new URL('../chunk-load-recovery.ts', import.meta.url), 'utf8');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('chunk-load-recovery (native fork)', () => {
  it('never classifies anything as a chunk failure, so the crash screen is unchanged', () => {
    const shaped = Object.assign(new Error('Loading module https://x/index-1.js failed.'), {
      name: 'AsyncRequireError',
    });
    expect(nativeFork.isChunkLoadError(shaped)).toBe(false);
  });

  it('recovers nothing', async () => {
    await expect(nativeFork.recoverFromChunkLoadError(new Error('x'))).resolves.toBe('exhausted');
    expect(nativeFork.reloadPage()).toBeUndefined();
    expect(nativeFork.markRootLayoutLoaded()).toBeUndefined();
  });

  it('references no browser global and imports nothing', () => {
    const code = stripComments(nativeSource);
    for (const browserGlobal of ['window', 'document', 'location', 'navigator', 'sessionStorage', 'fetch']) {
      expect(code).not.toMatch(new RegExp(`\\b${browserGlobal}\\b`));
    }
    expect(code).not.toMatch(/\bimport\b|\brequire\(/);
  });

  it('exports every symbol the web fork does that callers use, with the same constants', () => {
    for (const key of Object.keys(nativeFork)) {
      expect(typeof (webFork as Record<string, unknown>)[key]).toBe(
        typeof (nativeFork as Record<string, unknown>)[key],
      );
    }
    for (const constant of [
      'CHUNK_RELOAD_GUARD_KEY',
      'CHUNK_RELOAD_WINDOW_MS',
      'CHUNK_RELOAD_COUNT_KEY',
      'CHUNK_RELOAD_MAX_PER_TAB',
      'ROOT_LAYOUT_LOADED_FLAG',
    ] as const) {
      expect(nativeFork[constant], constant).toBe(webFork[constant]);
    }
  });
});
