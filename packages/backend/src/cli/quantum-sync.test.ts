import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const syncOnce = vi.hoisted(() => vi.fn());
vi.mock('../services/ewalls-catalog-sync', () => ({ syncQuantumCatalogOnce: syncOnce }));
import { runQuantumSyncCli } from './quantum-sync';
beforeEach(() => {
  syncOnce.mockReset();
  vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'quantum-catalog-sync');
});
afterEach(() => vi.unstubAllEnvs());

describe('Quantum sync command', () => {
  it('runs one explicit bootstrap through the shared importer', async () => {
    const signal = new AbortController().signal;
    const log = vi.fn();
    await runQuantumSyncCli(['once'], { signal, log });
    expect(syncOnce).toHaveBeenCalledExactlyOnceWith({ signal, log });
  });
  it('does not invoke the importer with the switch off', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'quantum-catalog-sync=false');
    await runQuantumSyncCli(['once']);
    expect(syncOnce).not.toHaveBeenCalled();
  });
  it.each([[], ['daemon'], ['once', 'extra']])('rejects obsolete or ambiguous arguments %j', async (...argv) => {
    await expect(runQuantumSyncCli(argv)).rejects.toThrow(
      /Scheduled sync runs through the quantum-catalog-sync background job/,
    );
    expect(syncOnce).not.toHaveBeenCalled();
  });
});
