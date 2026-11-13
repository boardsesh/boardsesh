import { createHash } from 'node:crypto';

export type MigrationMode = 'dry-run' | 'apply' | 'verify-only';
export type AssetMetadata = {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  expires?: Date;
  metadata?: Record<string, string>;
};
export type StoredAsset = AssetMetadata & {
  bytes: number;
  body: AsyncIterable<Uint8Array>;
};
export interface AssetStore {
  list(
    this: void,
    token?: string,
  ): Promise<{
    keys: string[];
    truncated: boolean;
    nextToken?: string;
  }>;
  get(this: void, key: string): Promise<StoredAsset | undefined>;
  put(this: void, key: string, contents: Uint8Array, metadata: AssetMetadata, checksum: string): Promise<void>;
}

const IMMUTABLE_KEY = /^static\/v1\/([a-f0-9]{64})\.(webp|png|ico|mp4|webm)$/;
const MAX_OBJECT_BYTES = 128 * 1024 * 1024;

export function parseMigrationMode(arguments_: readonly string[]): MigrationMode {
  return parseMigrationOptions(arguments_).mode;
}

export function parseMigrationOptions(arguments_: readonly string[]): { mode: MigrationMode; reverse: boolean } {
  const flags = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  if (flags.some((argument) => !['--dry-run', '--apply', '--verify-only', '--reverse'].includes(argument))) {
    throw new Error('Supported flags: --dry-run, --apply, --verify-only, --reverse');
  }
  const modes = flags.filter((flag) => flag !== '--reverse');
  if (modes.length > 1 || flags.filter((flag) => flag === '--reverse').length > 1)
    throw new Error('Choose exactly one migration mode and at most one --reverse flag');
  return {
    mode: modes[0] === '--apply' ? 'apply' : modes[0] === '--verify-only' ? 'verify-only' : 'dry-run',
    reverse: flags.includes('--reverse'),
  };
}

export async function inventoryAssets(store: AssetStore): Promise<string[]> {
  const keys = new Set<string>();
  const seenTokens = new Set<string>();
  let token: string | undefined;
  while (true) {
    const page = await store.list(token);
    for (const key of page.keys) {
      if (key === 'static/v1/manifest.json') continue;
      if (!IMMUTABLE_KEY.test(key)) throw new Error(`Unknown immutable asset key: ${key}`);
      if (keys.has(key)) throw new Error(`Duplicate asset in listing: ${key}`);
      keys.add(key);
    }
    if (!page.truncated) break;
    if (!page.nextToken || seenTokens.has(page.nextToken)) {
      throw new Error('Incomplete asset listing: missing or repeated continuation token');
    }
    token = page.nextToken;
    seenTokens.add(token);
  }
  return [...keys].sort();
}

function portableMetadata(asset: AssetMetadata): AssetMetadata {
  return {
    contentType: asset.contentType,
    cacheControl: asset.cacheControl,
    contentDisposition: asset.contentDisposition,
    contentEncoding: asset.contentEncoding,
    contentLanguage: asset.contentLanguage,
    expires: asset.expires,
    metadata: Object.fromEntries(
      Object.entries(asset.metadata ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

async function inspectAsset(key: string, asset: StoredAsset, retainBody: boolean) {
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > MAX_OBJECT_BYTES) {
    throw new Error(`Invalid or oversized asset ContentLength: ${key}`);
  }
  const digest = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of asset.body) {
    bytes += chunk.byteLength;
    if (bytes > asset.bytes) throw new Error(`Asset body exceeds ContentLength: ${key}`);
    digest.update(chunk);
    if (retainBody) chunks.push(chunk);
  }
  if (bytes !== asset.bytes) throw new Error(`Asset body differs from ContentLength: ${key}`);
  const hash = digest.digest();
  if (hash.toString('hex') !== IMMUTABLE_KEY.exec(key)?.[1]) throw new Error(`Corrupt immutable asset: ${key}`);
  return { contents: retainBody ? Buffer.concat(chunks) : undefined, checksum: hash.toString('base64') };
}

function isPreconditionFailed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode === 412
  );
}

export async function migrateStaticAssets(source: AssetStore, destination: AssetStore, mode: MigrationMode) {
  // Complete both inventories before allowing any write, including keys outside today's catalog.
  const sourceKeys = await inventoryAssets(source);
  if (mode !== 'dry-run' && !sourceKeys.length) throw new Error('Empty historical source inventory');
  const destinationKeys = new Set(await inventoryAssets(destination));
  const missingKeys = sourceKeys.filter((key) => !destinationKeys.has(key));
  if (mode === 'dry-run')
    return { sourceObjects: sourceKeys.length, missingObjects: missingKeys.length, copiedObjects: 0 };
  if (mode === 'verify-only' && missingKeys.length) throw new Error(`Missing historical assets: ${missingKeys.length}`);
  let copiedObjects = 0;
  let provedConditionalWrite = false;
  for (const key of sourceKeys) {
    const sourceAsset = await source.get(key);
    if (!sourceAsset) throw new Error(`Source asset disappeared: ${key}`);
    let destinationAsset = await destination.get(key);
    const inspectedSource = await inspectAsset(
      key,
      sourceAsset,
      !destinationAsset || (mode === 'apply' && !provedConditionalWrite),
    );
    if (!destinationAsset) {
      if (mode !== 'apply') throw new Error(`Missing historical asset: ${key}`);
      try {
        if (!inspectedSource.contents) throw new Error(`Missing buffered source asset: ${key}`);
        await destination.put(key, inspectedSource.contents, portableMetadata(sourceAsset), inspectedSource.checksum);
        copiedObjects += 1;
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
      }
      // Verify both successful writes and a concurrent writer's 412 response.
      destinationAsset = await destination.get(key);
      if (!destinationAsset) throw new Error(`Destination asset missing after upload: ${key}`);
    }
    await inspectAsset(key, destinationAsset, false);
    if (
      destinationAsset.bytes !== sourceAsset.bytes ||
      JSON.stringify(portableMetadata(destinationAsset)) !== JSON.stringify(portableMetadata(sourceAsset))
    ) {
      throw new Error(`Historical asset metadata mismatch: ${key}`);
    }
    if (mode === 'apply' && !provedConditionalWrite) {
      if (!inspectedSource.contents) throw new Error(`Missing buffered source asset: ${key}`);
      let rejectedDuplicate = false;
      try {
        // Identical bytes/metadata are safe even if a provider ignores IfNoneMatch.
        await destination.put(key, inspectedSource.contents, portableMetadata(sourceAsset), inspectedSource.checksum);
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
        rejectedDuplicate = true;
      }
      if (!rejectedDuplicate) throw new Error(`Conditional-write protection was ignored: ${key}`);
      provedConditionalWrite = true;
    }
  }
  return { sourceObjects: sourceKeys.length, missingObjects: missingKeys.length, copiedObjects };
}
