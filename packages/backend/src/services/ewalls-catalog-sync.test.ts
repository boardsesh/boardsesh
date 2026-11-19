import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { EwallsBootstrap, EwallsDelta, EwallsScope } from '@boardsesh/quantum-sync';
import { syncQuantumCatalogOnce } from './ewalls-catalog-sync';

const mocks = vi.hoisted(() => ({ load: vi.fn(), prepare: vi.fn(), apply: vi.fn() }));
vi.mock('./ewalls-catalog-state', () => ({ loadEwallsCatalogState: mocks.load }));
vi.mock('./ewalls-catalog-mapping', () => ({ prepareEwallsCatalog: mocks.prepare }));
vi.mock('./quantum-catalog-import', () => ({ importPreparedEwallsCatalog: mocks.apply }));

const environment = {
  QUANTUM_API_TOKEN: 'synthetic-secret',
  QUANTUM_API_ACCOUNT_ID: 'approved-catalogue-account',
  QUANTUM_API_CATALOG_VISIBILITY: 'public',
};
const scope = { board: '', forcedType: 'big' };
function batch(selectedScope: EwallsScope, checkpoint: string): EwallsBootstrap;
function batch(selectedScope: EwallsScope, checkpoint: string, baseCheckpoint: string): EwallsDelta;
function batch(
  selectedScope: EwallsScope,
  checkpoint: string,
  baseCheckpoint: string | null = null,
): EwallsBootstrap | EwallsDelta {
  const fields = {
    scope: selectedScope,
    checkpoint,
    routes: { upsert: [], deleted: [] },
    diodes: null,
    account: {
      ascents: { upsert: [], deleted: [] },
      favorites: { upsert: [], deleted: [] },
      projects: { upsert: [], deleted: [] },
    },
  };
  return baseCheckpoint === null
    ? { ...fields, kind: 'bootstrap', baseCheckpoint: null }
    : { ...fields, kind: 'delta', baseCheckpoint };
}
function client() {
  return {
    currentUser: vi.fn(async () => ({ id: 'approved-catalogue-account' })),
    bootstrap: vi.fn(async (selectedScope: EwallsScope) => batch(selectedScope, 'server / checkpoint')),
    delta: vi.fn(async (selectedScope: EwallsScope, checkpoint: string) =>
      batch(selectedScope, 'next server checkpoint', checkpoint),
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(null);
  mocks.prepare.mockReturnValue({ catalog: { normalized: true }, diodes: [{ id: 'known-diode' }] });
  mocks.apply.mockResolvedValue({ outcome: 'applied', climbsUpserted: 3 });
});

describe('direct eWalls catalogue worker orchestration', () => {
  it('requires an explicitly shared catalogue credential before doing any I/O', async () => {
    const upstream = client();
    await expect(
      syncQuantumCatalogOnce({ client: upstream, environment: { QUANTUM_API_TOKEN: 'personal-token' } }),
    ).rejects.toThrow(/shared eWalls catalogue/);
    expect(upstream.currentUser).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('rejects a credential bound to a different configured source account', async () => {
    await expect(
      syncQuantumCatalogOnce({
        client: client(),
        environment: { ...environment, QUANTUM_API_ACCOUNT_ID: 'different-account' },
      }),
    ).rejects.toThrow(/different configured account/);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('bootstraps all five model scopes without requiring a live Bluetooth board', async () => {
    const upstream = client();
    const result = await syncQuantumCatalogOnce({ environment, client: upstream });
    expect(upstream.bootstrap.mock.calls.map(([selected]) => selected)).toEqual([
      { board: '', forcedType: 'big' },
      { board: '', forcedType: 'medium' },
      { board: '', forcedType: 'small' },
      { board: '', forcedType: 'xsmall' },
      { board: '', forcedType: 'belay' },
    ]);
    expect(upstream.delta).not.toHaveBeenCalled();
    expect(result.source).toBe('ewalls-api');
    expect(result.scopes).toHaveLength(5);
    expect(mocks.apply).toHaveBeenCalledTimes(5);
  });
  it('passes the opaque checkpoint and previous diode cache to the delta pipeline', async () => {
    const upstream = client();
    const checkpoint = 'not-a-date / + % opaque';
    const diodes = [{ id: 'retained-diode' }];
    mocks.load.mockResolvedValue({ checkpoint, diodes });
    const signal = new AbortController().signal;
    await syncQuantumCatalogOnce({ environment, client: upstream, scopes: [scope], signal });
    expect(upstream.delta).toHaveBeenCalledExactlyOnceWith(scope, checkpoint, signal);
    expect(upstream.bootstrap).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ baseCheckpoint: checkpoint }),
      diodes,
      expect.any(Date),
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({ expectedCheckpoint: checkpoint, upstreamAccountId: 'approved-catalogue-account' }),
      expect.objectContaining({ signal }),
    );
  });
  it('does not apply data after incomplete acquisition or advance later model scopes', async () => {
    const upstream = client();
    upstream.bootstrap.mockRejectedValueOnce(new Error('incomplete upstream page'));
    await expect(syncQuantumCatalogOnce({ environment, client: upstream })).rejects.toThrow(/incomplete/);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(upstream.bootstrap).toHaveBeenCalledOnce();
  });
  it('passes the existing worker attempt fence to every import', async () => {
    const transaction = vi.fn();
    const log = vi.fn();
    await syncQuantumCatalogOnce({ environment, client: client(), scopes: [scope], transaction, log });
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transaction }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('eWalls big: bootstrap'));
    expect(JSON.stringify(log.mock.calls)).not.toContain(environment.QUANTUM_API_TOKEN);
  });
});
