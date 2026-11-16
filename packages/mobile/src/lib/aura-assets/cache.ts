import {
  AURA_ASSET_ORIGIN,
  auraGeometryScopeKey,
  type AuraGeometryAsset,
  type AuraGeometryManifest,
  type AuraGeometryScope,
} from './manifest';
import { selectAuraCacheSurvivors, type AuraCacheFile } from './cache-policy';

export type StoredAuraGeometry = Readonly<{ sha256: string; bytes: number; uri: string; lastUsed: number }>;

export type AuraGeometryCacheIO = Readonly<{
  list(): Promise<readonly StoredAuraGeometry[]>;
  remove(file: StoredAuraGeometry): Promise<void>;
  verify(file: StoredAuraGeometry, asset: AuraGeometryAsset): Promise<boolean>;
  /** Stream into a private partial, verify length/hash, then rename atomically. */
  download(asset: AuraGeometryAsset, url: string, signal: AbortSignal): Promise<StoredAuraGeometry>;
  exists(file: StoredAuraGeometry): boolean;
  isOnUnmeteredNetwork(): Promise<boolean>;
  now(): number;
}>;

/**
 * Optional acceleration has its own queue, disk budget and failures. It never
 * participates in board-download completion and publishes no render events.
 */
export function createAuraGeometryCache(manifest: AuraGeometryManifest, io: AuraGeometryCacheIO) {
  const verifiedFiles = new Map<string, StoredAuraGeometry>();
  let wantedAssets: AuraGeometryAsset[] = [];
  let offlineHashes = new Set<string>();
  let prefetchPriorities = new Map<string, number>();
  let running: Promise<void> | null = null;
  let active: { hash: string; controller: AbortController } | null = null;
  let stopped = false;

  const forget = async (file: StoredAuraGeometry) => {
    verifiedFiles.delete(file.sha256);
    await io.remove(file);
  };

  async function admit(asset: AuraGeometryAsset): Promise<boolean> {
    const existingFiles = await io.list();
    const incoming: AuraCacheFile = {
      key: asset.sha256,
      bytes: asset.bytes,
      lastUsed: io.now(),
      offline: offlineHashes.has(asset.sha256),
      priority: prefetchPriorities.get(asset.sha256) ?? 0,
    };
    const survivors = selectAuraCacheSurvivors(
      [
        ...existingFiles
          .filter((file) => file.sha256 !== asset.sha256)
          .map((file) => ({
            key: file.sha256,
            bytes: file.bytes,
            lastUsed: verifiedFiles.get(file.sha256)?.lastUsed ?? file.lastUsed,
            offline: offlineHashes.has(file.sha256),
            priority: prefetchPriorities.get(file.sha256) ?? 0,
          })),
        incoming,
      ],
      'compressed',
    );
    // A failed unlink aborts admission: bytes still on disk still count.
    for (const file of existingFiles) if (!survivors.has(file.sha256)) await forget(file);
    return survivors.has(asset.sha256);
  }

  async function consumeQueue(): Promise<void> {
    try {
      const files = await io.list();
      const survivors = selectAuraCacheSurvivors(
        files.map((file) => ({
          key: file.sha256,
          bytes: file.bytes,
          lastUsed: verifiedFiles.get(file.sha256)?.lastUsed ?? file.lastUsed,
          offline: offlineHashes.has(file.sha256),
          priority: prefetchPriorities.get(file.sha256) ?? 0,
        })),
        'compressed',
      );
      for (const file of files) if (!survivors.has(file.sha256)) await forget(file);
    } catch {
      // If old files cannot be accounted for or removed, do not add more.
      wantedAssets = [];
      return;
    }
    while (!stopped && wantedAssets.length > 0) {
      const asset = wantedAssets.shift();
      if (!asset) return;
      const controller = new AbortController();
      active = { hash: asset.sha256, controller };
      try {
        const existing = (await io.list()).find((file) => file.sha256 === asset.sha256);
        if (existing) {
          const previouslyVerified = verifiedFiles.get(asset.sha256);
          if (
            existing.bytes === asset.bytes &&
            ((previouslyVerified && io.exists(previouslyVerified)) || (await io.verify(existing, asset)))
          ) {
            verifiedFiles.set(asset.sha256, { ...existing, lastUsed: io.now() });
            continue;
          }
          await forget(existing);
        }
        if (controller.signal.aborted || !(await io.isOnUnmeteredNetwork())) continue;
        if (!(await admit(asset)) || controller.signal.aborted) continue;
        const file = await io.download(asset, `${AURA_ASSET_ORIGIN}/${asset.objectKey}`, controller.signal);
        // A late transfer can populate the cache without changing a live view.
        if (file.sha256 !== asset.sha256 || file.bytes !== asset.bytes || !(await io.verify(file, asset))) {
          await forget(file);
          continue;
        }
        verifiedFiles.set(asset.sha256, { ...file, lastUsed: io.now() });
      } catch {
        // Missing objects, disk exhaustion, corrupt bytes and cancellation all
        // leave local generation available. The next launch may try again.
      } finally {
        if (active?.controller === controller) active = null;
      }
    }
  }

  function start(): Promise<void> {
    if (running) return running;
    running = consumeQueue().finally(() => {
      running = null;
      // A request can replace the queue between the loop exiting and finally.
      if (!stopped && wantedAssets.length > 0) void start();
    });
    return running;
  }

  return {
    /** Call once per static configuration; never subscribe to download completion. */
    chooseLocal(asset: AuraGeometryAsset): string | null {
      const file = verifiedFiles.get(asset.sha256);
      if (!file || file.bytes !== asset.bytes || !io.exists(file)) {
        verifiedFiles.delete(asset.sha256);
        return null;
      }
      verifiedFiles.set(asset.sha256, { ...file, lastUsed: io.now() });
      return file.uri;
    },
    prefetch(selected: AuraGeometryScope | null, offlineScopes: readonly AuraGeometryScope[]): Promise<void> {
      stopped = false;
      const offlineKeys = new Set(offlineScopes.map(auraGeometryScopeKey));
      offlineHashes = new Set(
        manifest.assets.filter((asset) => offlineKeys.has(auraGeometryScopeKey(asset))).map((asset) => asset.sha256),
      );
      const selectedKey = selected ? auraGeometryScopeKey(selected) : null;
      const seen = new Set<string>();
      const prioritizedAssets = [
        ...manifest.assets.filter((asset) => auraGeometryScopeKey(asset) === selectedKey),
        ...manifest.assets.filter((asset) => offlineKeys.has(auraGeometryScopeKey(asset))),
      ].filter((asset) => {
        if (seen.has(asset.sha256)) return false;
        seen.add(asset.sha256);
        return true;
      });
      prefetchPriorities = new Map(
        prioritizedAssets.map((asset, index) => [asset.sha256, prioritizedAssets.length - index]),
      );
      wantedAssets = prioritizedAssets.filter(
        (asset) => active?.hash !== asset.sha256 || active.controller.signal.aborted,
      );
      if (active && !seen.has(active.hash)) active.controller.abort();
      return start();
    },
    stop(): void {
      stopped = true;
      wantedAssets = [];
      active?.controller.abort();
    },
  };
}
