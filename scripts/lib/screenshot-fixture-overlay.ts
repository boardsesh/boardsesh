import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  validateScreenshotFixtureManifest,
  findSensitiveVariableKeys,
  findUnpseudonymisedPersonFields,
  canonicalJson,
  type GraphqlFixtureFile,
} from './screenshot-fixtures';

export interface FixtureOverlayReference {
  path: string;
  sha256: string;
  bytes: number;
  /** Total files after applying the append-only overlay. */
  files: number;
}
const MAX_OVERLAY_BYTES = 8 * 1024 * 1024;
export function validateFixtureOverlayReference(candidate: unknown): FixtureOverlayReference {
  if (!candidate || typeof candidate !== 'object') throw new Error('Invalid fixture overlay reference');
  const reference = candidate as Partial<FixtureOverlayReference>;
  if (
    typeof reference.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    reference.path !== `app-stores/screenshot-fixture-overlays/${reference.sha256}.json.gz` ||
    !Number.isSafeInteger(reference.bytes) ||
    !reference.bytes ||
    reference.bytes < 1 ||
    reference.bytes > MAX_OVERLAY_BYTES ||
    !Number.isSafeInteger(reference.files) ||
    !reference.files ||
    reference.files < 1
  )
    throw new Error('Invalid fixture overlay reference');
  return reference as FixtureOverlayReference;
}

/** Adds genuine recordings to one exact archived baseline; never rewrites a recorded response. */
export function applyFixtureOverlay(
  base: ReadonlyMap<string, Buffer>,
  baseSha256: string,
  bytes: Buffer,
  reference: FixtureOverlayReference,
): Map<string, Buffer> {
  validateFixtureOverlayReference(reference);
  if (bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256)
    throw new Error('Fixture overlay checksum or byte count differs');
  const parsed = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_OVERLAY_BYTES }).toString()) as {
    version?: unknown;
    baseSha256?: unknown;
    files?: unknown;
  };
  if (
    parsed.version !== 1 ||
    parsed.baseSha256 !== baseSha256 ||
    !parsed.files ||
    typeof parsed.files !== 'object' ||
    Array.isArray(parsed.files)
  )
    throw new Error('Fixture overlay baseline or format differs');
  const merged = new Map(base);
  for (const [path, encoded] of Object.entries(parsed.files)) {
    if (
      !/^(manifest\.json|(?:graphql|static)\/[\w./-]+)$/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof encoded !== 'string'
    )
      throw new Error('Invalid fixture overlay path or contents');
    const content = Buffer.from(encoded, 'base64');
    if (content.toString('base64') !== encoded) throw new Error('Invalid fixture overlay encoding');
    if (path !== 'manifest.json' && base.has(path))
      throw new Error('Fixture overlay cannot replace a recorded response');
    merged.set(path, content);
  }
  const oldManifest = validateScreenshotFixtureManifest(JSON.parse(base.get('manifest.json')!.toString()));
  const newManifest = validateScreenshotFixtureManifest(JSON.parse(merged.get('manifest.json')!.toString()));
  if (!oldManifest.ok || !newManifest.ok) throw new Error('Fixture overlay manifest invalid');
  const previous = oldManifest.manifest,
    next = newManifest.manifest;
  if (
    previous.accountUserId !== next.accountUserId ||
    previous.accountEmail !== next.accountEmail ||
    previous.upstream !== next.upstream ||
    previous.flow !== next.flow ||
    Date.parse(next.frozenNow) < Date.parse(previous.frozenNow)
  )
    throw new Error('Fixture overlay recording provenance differs');
  const entries = [...next.graphql, ...next.static];
  for (const entry of [...previous.graphql, ...previous.static]) {
    if (!entries.some((candidate) => canonicalJson(candidate) === canonicalJson(entry)))
      throw new Error('Fixture overlay removed or changed archived provenance');
  }
  if (
    merged.size !== reference.files ||
    entries.length + 1 !== merged.size ||
    entries.some((entry) => !merged.has(entry.file))
  )
    throw new Error('Incomplete fixture overlay');
  for (const entry of next.graphql) {
    if (base.has(entry.file)) continue;
    const fixture = JSON.parse(merged.get(entry.file)!.toString()) as GraphqlFixtureFile;
    if (
      findSensitiveVariableKeys(fixture.variables).length ||
      findUnpseudonymisedPersonFields(fixture.response, {
        ownUserId: next.accountUserId,
        approvedTestUserIds: next.approvedTestUserIds,
      }).length
    )
      throw new Error('Fixture overlay includes unsanitized data');
  }
  return merged;
}
