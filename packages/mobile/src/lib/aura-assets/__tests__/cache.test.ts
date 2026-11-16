import { describe, expect, it, vi } from 'vitest';
import { createAuraGeometryCache, type AuraGeometryCacheIO, type StoredAuraGeometry } from '../cache';
import { selectAuraCacheSurvivors } from '../cache-policy';
import {
  AURA_COMPRESSED_BUDGET_BYTES,
  findAuraGeometryAsset,
  readAuraGeometryManifest,
  type AuraGeometryAsset,
} from '../manifest';

function asset(index: number, override: Partial<AuraGeometryAsset> = {}): AuraGeometryAsset {
  const hash = index.toString(16).padStart(64, '0');
  return {
    boardType: 'kilter',
    layoutId: index,
    sizeId: 25,
    geometryId: hash,
    formatRevision: 2,
    atlasFormatRevision: 2,
    outputWidth: 1080,
    outputHeight: 1504,
    sha256: hash,
    bytes: 100,
    maxReach: 60,
    pulseReach: 1.35,
    objectKey: `static/v1/${hash}.aura`,
    ...override,
  };
}

function stored(candidate: AuraGeometryAsset): StoredAuraGeometry {
  return { sha256: candidate.sha256, bytes: candidate.bytes, uri: `file:///${candidate.sha256}.aura`, lastUsed: 1 };
}

function harness(initialFiles: StoredAuraGeometry[] = []) {
  const files = new Map(initialFiles.map((file) => [file.sha256, file]));
  const io: AuraGeometryCacheIO = {
    list: vi.fn(async () => [...files.values()]),
    remove: vi.fn(async (file) => {
      files.delete(file.sha256);
    }),
    verify: vi.fn(async () => true),
    download: vi.fn(async (candidate) => {
      const file = stored(candidate);
      files.set(file.sha256, file);
      return file;
    }),
    exists: vi.fn((file) => files.has(file.sha256)),
    isOnUnmeteredNetwork: vi.fn(async () => true),
    now: () => 10,
  };
  return { io, files };
}

describe('Aura manifest compatibility', () => {
  it('requires exact dimensions and rejects incompatible or repeated records', () => {
    const manifest = { version: 1, assets: [asset(1)] } as const;
    expect(readAuraGeometryManifest(manifest)).toEqual(manifest);
    expect(findAuraGeometryAsset(manifest, asset(1), 1080, 1504)).toEqual(asset(1));
    expect(findAuraGeometryAsset(manifest, asset(1), 768, 1070)).toBeNull();
    expect(readAuraGeometryManifest({ version: 1, assets: [asset(1), asset(1)] })).toBeNull();
    expect(
      readAuraGeometryManifest({ version: 1, assets: [asset(1), asset(1, { layoutId: 2, bytes: 101 })] }),
    ).toBeNull();
    for (const candidate of [
      asset(1, { formatRevision: 1 }),
      asset(1, { atlasFormatRevision: 1 }),
      asset(1, { boardType: 'spray' }),
      asset(1, { bytes: AURA_COMPRESSED_BUDGET_BYTES + 1 }),
      asset(1, { outputHeight: 2305 }),
      asset(1, { objectKey: '../escape' }),
      asset(1, { objectKey: `aura/v2/${asset(1).sha256}.aura` }),
      asset(1, { maxReach: Number.NaN }),
    ]) {
      expect(readAuraGeometryManifest({ version: 1, assets: [candidate] })).toBeNull();
    }
  });
});

describe('Aura cache ceilings', () => {
  it('enforces both generated ceilings while preferring offline boards', () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      key: String(index),
      bytes: 1024,
      lastUsed: index,
      offline: index === 0,
    }));
    expect([...selectAuraCacheSurvivors(files, 'generated')]).toEqual(['0', '5', '4', '3']);
    expect([
      ...selectAuraCacheSurvivors(
        files.map((file) => ({ ...file, bytes: 100 * 1024 * 1024 })),
        'generated',
      ),
    ]).toEqual(['0', '5']);
    expect(
      selectAuraCacheSurvivors(
        [{ key: 'offline-too-large', bytes: AURA_COMPRESSED_BUDGET_BYTES + 1, lastUsed: 1, offline: true }],
        'compressed',
      ).size,
    ).toBe(0);
  });
});

describe('optional Aura prefetch', () => {
  it('fetches selected then offline, deduplicates geometry, and serializes transfers', async () => {
    const first = asset(1);
    const second = asset(2);
    const alias = asset(3, { sha256: second.sha256, objectKey: second.objectKey });
    const { io } = harness();
    let concurrent = 0;
    let peak = 0;
    vi.mocked(io.download).mockImplementation(async (candidate) => {
      peak = Math.max(peak, ++concurrent);
      await Promise.resolve();
      concurrent--;
      return stored(candidate);
    });
    const cache = createAuraGeometryCache({ version: 1, assets: [first, second, alias] }, io);
    await cache.prefetch(second, [first, second, alias]);
    expect(vi.mocked(io.download).mock.calls.map(([candidate]) => candidate.sha256)).toEqual([
      second.sha256,
      first.sha256,
    ]);
    expect(peak).toBe(1);
  });

  it('verifies an existing file on metered launch without downloading', async () => {
    const first = asset(1);
    const second = asset(2);
    const { io } = harness([stored(first)]);
    vi.mocked(io.isOnUnmeteredNetwork).mockResolvedValue(false);
    const cache = createAuraGeometryCache({ version: 1, assets: [first, second] }, io);
    await cache.prefetch(first, [second]);
    expect(cache.chooseLocal(first)).toBe(stored(first).uri);
    expect(cache.chooseLocal(second)).toBeNull();
    expect(io.download).not.toHaveBeenCalled();
  });

  it('does not revise a preparation decision when its download finishes', async () => {
    const first = asset(1);
    const { io, files } = harness();
    let finish: (() => void) | undefined;
    vi.mocked(io.download).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            const file = stored(first);
            files.set(file.sha256, file);
            resolve(file);
          };
        }),
    );
    const cache = createAuraGeometryCache({ version: 1, assets: [first] }, io);
    const preparing = cache.prefetch(first, []);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const preparationChoice = cache.chooseLocal(first);
    expect(preparationChoice).toBeNull();
    finish?.();
    await preparing;
    expect(preparationChoice).toBeNull();
    expect(cache.chooseLocal(first)).toBe(stored(first).uri);
    files.clear();
    expect(cache.chooseLocal(first)).toBeNull();
  });

  it('discards corrupt files and keeps download errors independent of board completion', async () => {
    const first = asset(1);
    const { io } = harness([stored(first)]);
    vi.mocked(io.verify).mockResolvedValue(false);
    vi.mocked(io.download).mockRejectedValue(new Error('disk full'));
    const cache = createAuraGeometryCache({ version: 1, assets: [first] }, io);
    await expect(cache.prefetch(first, [])).resolves.toBeUndefined();
    expect(io.remove).toHaveBeenCalledWith(stored(first));
    expect(cache.chooseLocal(first)).toBeNull();
  });

  it('cancels superseded transfers and never overlaps their replacements', async () => {
    const first = asset(1);
    const second = asset(2);
    const { io, files } = harness();
    let firstSignal: AbortSignal | undefined;
    vi.mocked(io.download).mockImplementation(async (candidate, _url, signal) => {
      if (candidate.sha256 === first.sha256) {
        firstSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      const file = stored(candidate);
      files.set(file.sha256, file);
      return file;
    });
    const cache = createAuraGeometryCache({ version: 1, assets: [first, second] }, io);
    const old = cache.prefetch(first, []);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const replacement = cache.prefetch(second, []);
    await Promise.all([old, replacement]);
    expect(firstSignal?.aborted).toBe(true);
    expect(cache.chooseLocal(second)).toBe(stored(second).uri);
  });

  it('refuses new storage when a required eviction fails', async () => {
    const first = asset(1, { bytes: AURA_COMPRESSED_BUDGET_BYTES });
    const second = asset(2, { bytes: AURA_COMPRESSED_BUDGET_BYTES });
    const { io } = harness([stored(first)]);
    vi.mocked(io.remove).mockRejectedValue(new Error('unlink denied'));
    const cache = createAuraGeometryCache({ version: 1, assets: [first, second] }, io);
    await cache.prefetch(second, []);
    expect(io.download).not.toHaveBeenCalled();
  });

  it('prunes old excess files before an existing-file hit, respecting offline preference', async () => {
    const first = asset(1, { bytes: 150 * 1024 * 1024 });
    const second = asset(2, { bytes: 150 * 1024 * 1024 });
    const { io, files } = harness([stored(first), stored(second)]);
    vi.mocked(io.isOnUnmeteredNetwork).mockResolvedValue(false);
    const cache = createAuraGeometryCache({ version: 1, assets: [first, second] }, io);
    await cache.prefetch(first, [second]);
    expect([...files.keys()]).toEqual([second.sha256]);
    expect(cache.chooseLocal(first)).toBeNull();
    expect(cache.chooseLocal(second)).toBe(stored(second).uri);
    expect(io.download).not.toHaveBeenCalled();
  });

  it('requeues the same selection after cancelling an older transfer for that board', async () => {
    const first = asset(1);
    const { io, files } = harness();
    let firstSignal: AbortSignal | undefined;
    vi.mocked(io.download)
      .mockImplementationOnce(async (_candidate, _url, signal) => {
        firstSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      })
      .mockImplementation(async (candidate) => {
        const file = stored(candidate);
        files.set(file.sha256, file);
        return file;
      });
    const cache = createAuraGeometryCache({ version: 1, assets: [first] }, io);
    const original = cache.prefetch(first, []);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    cache.stop();
    const resumed = cache.prefetch(first, []);
    await Promise.all([original, resumed]);
    expect(io.download).toHaveBeenCalledTimes(2);
    expect(cache.chooseLocal(first)).toBe(stored(first).uri);
  });

  it('retains selected offline geometry and avoids repeated downloads above the budget', async () => {
    const first = asset(1, { bytes: 150 * 1024 * 1024 });
    const second = asset(2, { bytes: 150 * 1024 * 1024 });
    const { io, files } = harness();
    const cache = createAuraGeometryCache({ version: 1, assets: [first, second] }, io);
    await cache.prefetch(second, [first, second]);
    expect([...files.keys()]).toEqual([second.sha256]);
    expect(io.download).toHaveBeenCalledTimes(1);
    await cache.prefetch(second, [first, second]);
    expect(io.download).toHaveBeenCalledTimes(1);
    expect(cache.chooseLocal(second)).toBe(stored(second).uri);
  });
});
