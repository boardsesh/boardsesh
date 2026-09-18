import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURE_SNAPSHOT_REFERENCE = join(REPO_ROOT, 'app-stores/screenshot-fixtures.json');
const CACHE_ROOT = join(REPO_ROOT, '.boardsesh/screenshot-fixtures');
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export interface FixtureSnapshotReference {
  version: 1;
  url: string;
  sha256: string;
  bytes: number;
  files: number;
}

export function snapshotHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readFixtureSnapshotReference(filename = FIXTURE_SNAPSHOT_REFERENCE): FixtureSnapshotReference {
  const parsed: unknown = JSON.parse(readFileSync(filename, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error(`Invalid fixture snapshot reference: ${filename}`);
  const reference = parsed as Partial<FixtureSnapshotReference>;
  if (
    reference.version !== 1 ||
    typeof reference.url !== 'string' ||
    !reference.url.startsWith('https://') ||
    typeof reference.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    !reference.bytes ||
    reference.bytes < 1 ||
    reference.bytes > MAX_SNAPSHOT_BYTES ||
    !Number.isSafeInteger(reference.files) ||
    !reference.files ||
    reference.files < 1
  ) {
    throw new Error(`Invalid fixture snapshot reference: ${filename}`);
  }
  return reference as FixtureSnapshotReference;
}

export function fixtureSnapshotDirectory(reference = readFixtureSnapshotReference(), cacheRoot = CACHE_ROOT): string {
  return join(cacheRoot, reference.sha256);
}

export function decodeFixtureSnapshot(bytes: Buffer, reference: FixtureSnapshotReference): Map<string, Buffer> {
  if (bytes.length !== reference.bytes || snapshotHash(bytes) !== reference.sha256) {
    throw new Error('Screenshot fixture snapshot checksum or byte count differs from the pinned reference');
  }
  const parsed: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_SNAPSHOT_BYTES }).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('files' in parsed)) {
    throw new Error('Invalid screenshot fixture snapshot');
  }
  const encoded = parsed.files;
  if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) throw new Error('Invalid snapshot files');
  const files = new Map<string, Buffer>();
  for (const [path, content] of Object.entries(encoded)) {
    if (
      !/^(manifest\.json|(?:graphql|static)\/[\w./-]+)$/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof content !== 'string'
    ) {
      throw new Error(`Invalid screenshot fixture snapshot path: ${path}`);
    }
    const decoded = Buffer.from(content, 'base64');
    if (decoded.toString('base64') !== content) throw new Error(`Invalid snapshot encoding: ${path}`);
    files.set(path, decoded);
  }
  if (!files.has('manifest.json') || files.size !== reference.files) throw new Error('Incomplete fixture snapshot');
  return files;
}

function writeAtomic(filename: string, bytes: Buffer): void {
  mkdirSync(dirname(filename), { recursive: true });
  const staged = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(staged, bytes, { flag: 'wx' });
  renameSync(staged, filename);
}

/** A content-addressed cache; local recordings are never read, changed, or removed. */
export async function ensureScreenshotFixtures(
  reference = readFixtureSnapshotReference(),
  cacheRoot = CACHE_ROOT,
  request: typeof fetch = fetch,
): Promise<string> {
  const archive = join(cacheRoot, `${reference.sha256}.json.gz`);
  let compressed = existsSync(archive) ? readFileSync(archive) : null;
  if (!compressed || compressed.length !== reference.bytes || snapshotHash(compressed) !== reference.sha256) {
    const response = await request(reference.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error(`Fixture snapshot download failed: HTTP ${response.status}`);
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > reference.bytes) throw new Error('Fixture snapshot download exceeds the pinned byte count');
      chunks.push(chunk);
    }
    compressed = Buffer.concat(chunks);
    // Check every path and the complete checksum before writing anything.
    decodeFixtureSnapshot(compressed, reference);
    writeAtomic(archive, compressed);
  }
  const files = decodeFixtureSnapshot(compressed, reference);
  const directory = fixtureSnapshotDirectory(reference, cacheRoot);
  for (const [path, bytes] of files) {
    const filename = join(directory, path);
    if (!existsSync(filename) || !readFileSync(filename).equals(bytes)) writeAtomic(filename, bytes);
  }
  return directory;
}
