import { fetch } from 'expo/fetch';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { isOnUnmeteredNetwork } from '../../offline/offline-sync-adapter';
import type { AuraCacheKind } from './cache-policy';
import { createAuraGeometryCache, type AuraGeometryCacheIO, type StoredAuraGeometry } from './cache';
import {
  findAuraGeometryAsset,
  isAuraCatalogueFamily,
  readAuraGeometryManifest,
  type AuraGeometryAsset,
  type AuraGeometryScope,
} from './manifest';
import generatedManifest from './generated/manifest.json';

const SHA_FILE = /^([a-f0-9]{64})\.aura$/;
const DIRECTORY_NAMES = { compressed: 'aura-geometry-v2', generated: 'aura-generated-v2' } as const;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const DISK_SLACK_BYTES = 8 * 1024 * 1024;
let partialSequence = 0;

function directory(kind: AuraCacheKind): Directory {
  return new Directory(Paths.cache, DIRECTORY_NAMES[kind]);
}

function removeIfPresent(file: File): void {
  if (file.exists) file.delete();
}

function listFiles(kind: AuraCacheKind): StoredAuraGeometry[] {
  const store = directory(kind);
  store.create({ intermediates: true, idempotent: true });
  const stored: StoredAuraGeometry[] = [];
  for (const entry of store.list()) {
    if (!(entry instanceof File)) continue;
    if (entry.name.endsWith('.part')) {
      // This queue has one transfer and never lists while it writes a partial.
      removeIfPresent(entry);
      continue;
    }
    const match = SHA_FILE.exec(entry.name);
    if (match) stored.push({ sha256: match[1], bytes: entry.size, uri: entry.uri, lastUsed: entry.lastModified ?? 0 });
  }
  return stored;
}

async function verifyFile(file: StoredAuraGeometry, asset: AuraGeometryAsset): Promise<boolean> {
  try {
    const stored = new File(file.uri);
    return (
      stored.exists &&
      stored.size === asset.bytes &&
      (await stored.digest('SHA-256')) === asset.sha256 &&
      stored.size === asset.bytes
    );
  } catch {
    return false;
  }
}

/** Bounded streamed writes avoid loading an entire compressed board into JS. */
async function downloadFile(asset: AuraGeometryAsset, url: string, signal: AbortSignal): Promise<StoredAuraGeometry> {
  if (Paths.availableDiskSpace < asset.bytes + DISK_SLACK_BYTES) throw new Error('Aura cache disk is full');
  const store = directory('compressed');
  store.create({ intermediates: true, idempotent: true });
  const destination = new File(store, `${asset.sha256}.aura`);
  const partial = new File(store, `${asset.sha256}-${Date.now()}-${++partialSequence}.part`);
  // Expo mutates File.uri when moving it. Cleanup must retain the old staging
  // address, otherwise it would unlink the successfully published destination.
  const partialUri = partial.uri;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const deadline = setTimeout(cancel, DOWNLOAD_TIMEOUT_MS);
  let handle: ReturnType<File['open']> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
    });
    if (!response.ok || response.url !== url || !response.body) throw new Error('Aura geometry is unavailable');
    const declaredBytes = response.headers.get('content-length');
    if (declaredBytes !== null && Number(declaredBytes) !== asset.bytes)
      throw new Error('Aura geometry length changed');
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('Aura geometry has an unexpected encoding');
    partial.create({ overwrite: false });
    handle = partial.open(FileMode.WriteOnly);
    reader = response.body.getReader();
    let receivedBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (controller.signal.aborted || chunk.value.byteLength > asset.bytes - receivedBytes) {
        throw new Error('Aura geometry exceeded its bound');
      }
      await handle.writeBytes(chunk.value);
      receivedBytes += chunk.value.byteLength;
    }
    handle.close();
    handle = null;
    if (controller.signal.aborted || receivedBytes !== asset.bytes) throw new Error('Aura geometry is incomplete');
    const staged = { sha256: asset.sha256, bytes: partial.size, uri: partial.uri, lastUsed: Date.now() };
    if (!(await verifyFile(staged, asset))) throw new Error('Aura geometry checksum differs');
    if (controller.signal.aborted) throw new Error('Aura geometry download was cancelled');
    // Never replace a complete file with a partial. Another process's complete
    // immutable copy is usable only after the same verification.
    if (destination.exists) {
      const existing = { ...staged, uri: destination.uri, bytes: destination.size };
      if (await verifyFile(existing, asset)) return existing;
      destination.delete();
    }
    partial.moveSync(destination);
    return { ...staged, uri: destination.uri };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancel);
    controller.abort();
    try {
      await reader?.cancel();
    } catch {
      // The request may already have rejected or completed.
    }
    handle?.close();
    removeIfPresent(new File(partialUri));
  }
}

const nativeIO: AuraGeometryCacheIO = {
  async list() {
    return listFiles('compressed');
  },
  async remove(file) {
    removeIfPresent(new File(file.uri));
  },
  verify: verifyFile,
  download: downloadFile,
  exists(file) {
    try {
      const stored = new File(file.uri);
      return stored.exists && stored.size === file.bytes;
    } catch {
      return false;
    }
  },
  isOnUnmeteredNetwork,
  now: Date.now,
};

export const auraGeometryManifest = readAuraGeometryManifest(generatedManifest) ?? { version: 1, assets: [] };
export const auraGeometryCache = createAuraGeometryCache(auraGeometryManifest, nativeIO);

/** Native pruning reads only the complete rename; offline boards still obey both caps. */
export function rememberAuraOfflineScopes(scopes: readonly AuraGeometryScope[]): void {
  try {
    const store = directory('generated');
    store.create({ intermediates: true, idempotent: true });
    const scopeKeys = [
      ...new Set(
        scopes
          .filter((scope) => isAuraCatalogueFamily(scope.boardType))
          .map((scope) => `${scope.boardType}/${scope.layoutId}-${scope.sizeId}`),
      ),
    ].sort();
    const contents = JSON.stringify(scopeKeys.slice(0, 256));
    const destination = new File(store, '.offline-scopes.json');
    const partial = new File(store, '.offline-scopes.json.part');
    partial.writeSync(contents);
    partial.moveSync(destination, { overwrite: true });
  } catch {
    // This is an eviction preference; inability to write it cannot block climbing.
  }
}

export type AuraGeometryPaths = Readonly<{
  geometryAssetPath: string | null;
  geometryAssetSha256: string | null;
  generatedGeometryDirectory: string | null;
}>;

/**
 * Capture once when static configuration changes. A later download has no
 * notification channel into this choice. Rust owns generated-cache writes and
 * admission, so JS never unlinks a file while native preparation is using it.
 */
export function selectAuraGeometryPaths(
  scope: AuraGeometryScope,
  outputWidth: number,
  outputHeight: number,
): AuraGeometryPaths {
  const asset = findAuraGeometryAsset(auraGeometryManifest, scope, outputWidth, outputHeight);
  const path = asset ? auraGeometryCache.chooseLocal(asset) : null;
  let generatedDirectory: string | null = null;
  try {
    const store = directory('generated');
    store.create({ intermediates: true, idempotent: true });
    generatedDirectory = store.uri;
  } catch {
    // Read-only/full disk still permits normal in-memory generation.
  }
  return {
    geometryAssetPath: path,
    geometryAssetSha256: path ? (asset?.sha256 ?? null) : null,
    generatedGeometryDirectory: generatedDirectory,
  };
}
