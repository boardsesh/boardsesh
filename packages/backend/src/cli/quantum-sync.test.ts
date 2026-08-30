import { beforeEach, describe, expect, it, vi } from 'vitest';
const syncOnce = vi.hoisted(() => vi.fn());
vi.mock('../services/quantum-catalog-sync', () => ({ syncQuantumCatalogOnce: syncOnce }));
import { runQuantumSyncCli } from './quantum-sync';
beforeEach(() => {
  syncOnce.mockReset();
});

describe('Quantum sync command', () => {
  it('runs one explicit bootstrap through the shared importer', async () => {
    const signal = new AbortController().signal;
    const log = vi.fn();
    await runQuantumSyncCli(['once'], { signal, log });
    expect(syncOnce).toHaveBeenCalledExactlyOnceWith({ signal, log });
  });
  it.each([[], ['daemon'], ['once', 'extra']])('rejects obsolete or ambiguous arguments %j', async (...argv) => {
    await expect(runQuantumSyncCli(argv)).rejects.toThrow(
      /Scheduled sync runs through the quantum-catalog-sync background job/,
    );
    expect(syncOnce).not.toHaveBeenCalled();
  });
});
