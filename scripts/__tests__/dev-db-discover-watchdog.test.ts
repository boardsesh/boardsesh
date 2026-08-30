import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscoveryTimeoutError, raceAgainstWatchdog } from '../dev-db-discover';

// Regression coverage for https://github.com/boardsesh/boardsesh/issues/3874:
// `dev-db-discover.ts` could exit 0 mid-`await` before `discoverDatabase()`
// ever resolved, because nothing kept Bun's event loop alive while a
// postgres.js `client.end()` promise sat unsettled on a half-open socket.
// `raceAgainstWatchdog` fixes that by racing discovery against a real
// (non-unref'd) timer so a stuck probe surfaces as a loud, typed timeout
// instead of a silent premature exit.

describe('raceAgainstWatchdog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with a DiscoveryTimeoutError when the operation never settles', async () => {
    const neverSettles = new Promise<never>(() => undefined);

    await expect(raceAgainstWatchdog(neverSettles, 20)).rejects.toBeInstanceOf(DiscoveryTimeoutError);
    await expect(raceAgainstWatchdog(neverSettles, 20)).rejects.toThrow('Discovery timed out after 20ms');
  });

  it('resolves pass-through and clears the watchdog timer when the operation settles first', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    await expect(raceAgainstWatchdog(Promise.resolve('selection'), 5_000)).resolves.toBe('selection');

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('propagates a genuine rejection from the operation instead of masking it as a timeout', async () => {
    const operationError = new Error('boom');

    await expect(raceAgainstWatchdog(Promise.reject(operationError), 5_000)).rejects.toBe(operationError);
  });
});

describe('dev-db-discover.ts module import', () => {
  it('does not execute main() (no process.exit side effects) on import', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit should not be called on import');
    });

    // Fresh import so any previously-cached module evaluation from another
    // test file can't hide a regression here.
    await vi.importActual('../dev-db-discover');

    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('dev-db-discover.ts source invariants', () => {
  const source = readFileSync(join(__dirname, '..', 'dev-db-discover.ts'), 'utf8');

  it('guards the main() invocation with an entry-point check so importing the module has no side effects', () => {
    expect(source).toMatch(/if\s*\(\s*isEntryPoint\(\)\s*\)\s*\{\s*\n\s*main\(\)/);
  });

  it('does not gate main() on import.meta.main, which is undefined under tsx', () => {
    const executableLines = source.split('\n').filter((line) => !line.trim().startsWith('//'));
    expect(executableLines.join('\n')).not.toMatch(/import\.meta\.main/);
  });

  it('compares real entry-point paths so symlinked invocations still run main()', () => {
    expect(source).toMatch(/realpathSync\(entryPath\)\s*===\s*realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  });

  it('bounds every postgres.js client.end() call with an explicit force-close timeout', () => {
    const endCallLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .filter((line) => line.includes('client.end('));
    expect(endCallLines.length).toBeGreaterThan(0);
    for (const line of endCallLines) {
      expect(line).toMatch(/timeout:\s*\d+/);
    }
  });
});
