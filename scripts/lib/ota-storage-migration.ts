/// <reference types="node" />

export type StorageProvider = 'tigris' | 'r2' | 'unknown';

export type ObjectInventoryEntry = Readonly<{
  key: string;
  size: number;
}>;

export type ObjectMetadata = Readonly<{
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  expires: string | null;
  userMetadata: Readonly<Record<string, string>>;
}>;

export type ObjectFingerprint = Readonly<{
  size: number;
  sha256: string;
  metadata: ObjectMetadata;
}>;

export type InventoryDifference = Readonly<{
  missing: readonly string[];
  extra: readonly string[];
  sizeMismatches: readonly Readonly<{ key: string; sourceSize: number; destinationSize: number }>[];
}>;

export type VerificationProblem = Readonly<{
  key: string;
  kind: 'missing' | 'extra' | 'size' | 'content' | 'metadata';
  detail: string;
}>;

/** Classify a storage endpoint without returning or logging its path or credentials. */
export function classifyStorageEndpoint(rawEndpoint: string): StorageProvider {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    return 'unknown';
  }

  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    return 'unknown';
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (hostname.endsWith('.r2.cloudflarestorage.com')) return 'r2';
  if (hostname === 't3.storage.dev' || hostname.endsWith('.tigris.dev')) return 'tigris';
  return 'unknown';
}

function inventoryMap(entries: readonly ObjectInventoryEntry[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const entry of entries) {
    if (result.has(entry.key)) throw new Error(`Duplicate object key in inventory: ${entry.key}`);
    result.set(entry.key, entry.size);
  }
  return result;
}

/** Compare the complete source and destination listings. Extra destination keys are a cutover blocker. */
export function diffInventories(
  source: readonly ObjectInventoryEntry[],
  destination: readonly ObjectInventoryEntry[],
): InventoryDifference {
  const sourceSizes = inventoryMap(source);
  const destinationSizes = inventoryMap(destination);
  const missing: string[] = [];
  const extra: string[] = [];
  const sizeMismatches: { key: string; sourceSize: number; destinationSize: number }[] = [];

  for (const [key, sourceSize] of sourceSizes) {
    const destinationSize = destinationSizes.get(key);
    if (destinationSize === undefined) missing.push(key);
    else if (destinationSize !== sourceSize) sizeMismatches.push({ key, sourceSize, destinationSize });
  }
  for (const key of destinationSizes.keys()) {
    if (!sourceSizes.has(key)) extra.push(key);
  }

  missing.sort();
  extra.sort();
  sizeMismatches.sort((left, right) => left.key.localeCompare(right.key));
  return { missing, extra, sizeMismatches };
}

/** Copy mode cannot reconcile destination-only keys because deletion is deliberately unsupported. */
export function assertCopyPreflight(
  source: readonly ObjectInventoryEntry[],
  destination: readonly ObjectInventoryEntry[],
): void {
  const { extra } = diffInventories(source, destination);
  if (extra.length > 0) {
    throw new Error(
      `Destination contains ${extra.length} object(s) absent from Tigris. ` +
        'No objects were copied; investigate the extras manually because this tool never deletes.',
    );
  }
}

function sortedMetadata(metadata: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata)
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Destination metadata must remain byte-for-byte portable from the source. */
export function expectedDestinationMetadata(source: ObjectFingerprint): ObjectMetadata {
  return { ...source.metadata, userMetadata: sortedMetadata(source.metadata.userMetadata) };
}

export function metadataMatches(left: ObjectMetadata, right: ObjectMetadata): boolean {
  return (
    JSON.stringify({ ...left, userMetadata: sortedMetadata(left.userMetadata) }) ===
    JSON.stringify({ ...right, userMetadata: sortedMetadata(right.userMetadata) })
  );
}

export function fingerprintsMatch(left: ObjectFingerprint, right: ObjectFingerprint): boolean {
  return left.size === right.size && left.sha256 === right.sha256 && metadataMatches(left.metadata, right.metadata);
}

/**
 * Verify exact inventories, then compare every common object by full SHA-256 and metadata.
 * The loader performs the provider reads; this layer stays deterministic and directly testable.
 */
export async function verifyObjectStores(
  sourceInventory: readonly ObjectInventoryEntry[],
  destinationInventory: readonly ObjectInventoryEntry[],
  loadFingerprint: (side: 'source' | 'destination', key: string) => Promise<ObjectFingerprint>,
  concurrency = 4,
): Promise<readonly VerificationProblem[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error('Verification concurrency must be positive.');
  const difference = diffInventories(sourceInventory, destinationInventory);
  const problems: VerificationProblem[] = [
    ...difference.missing.map((key) => ({ key, kind: 'missing' as const, detail: 'absent from destination' })),
    ...difference.extra.map((key) => ({ key, kind: 'extra' as const, detail: 'absent from source' })),
    ...difference.sizeMismatches.map(({ key, sourceSize, destinationSize }) => ({
      key,
      kind: 'size' as const,
      detail: `source=${sourceSize} destination=${destinationSize}`,
    })),
  ];

  const blocked = new Set([
    ...difference.missing,
    ...difference.extra,
    ...difference.sizeMismatches.map(({ key }) => key),
  ]);
  const keys = sourceInventory.map(({ key }) => key).filter((key) => !blocked.has(key));
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (nextIndex < keys.length) {
      const key = keys[nextIndex];
      nextIndex += 1;
      const [source, destination] = await Promise.all([
        loadFingerprint('source', key),
        loadFingerprint('destination', key),
      ]);
      if (source.size !== destination.size) {
        problems.push({ key, kind: 'size', detail: `source=${source.size} destination=${destination.size}` });
      } else if (source.sha256 !== destination.sha256) {
        problems.push({ key, kind: 'content', detail: 'SHA-256 differs' });
      } else if (!metadataMatches(expectedDestinationMetadata(source), destination.metadata)) {
        problems.push({ key, kind: 'metadata', detail: 'HTTP or user metadata differs' });
      }
    }
  });
  await Promise.all(workers);

  return problems.sort((left, right) => left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind));
}
