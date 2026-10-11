import { createHash } from 'node:crypto';

export const TUTORIAL_SNAPSHOT_BUCKET = 'tutorial-snapshots';
export const TUTORIAL_SNAPSHOT_PREFIX = 'tutorials/fixtures/snapshots/v1';
export const tutorialSnapshotSha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

export type TutorialSnapshotObject = Readonly<{
  key: string;
  filename: string;
  bytes: number;
  sha256: string;
  contentType: string;
  contentEncoding?: 'gzip';
}>;
export type TutorialSnapshotCache = Readonly<{
  formatVersion: 1;
  inputSha256: string;
  objects: readonly TutorialSnapshotObject[];
}>;

/** Validate every destination before loading the exporter or constructing a client. */
export function assertTutorialSnapshotEnvironment(env: NodeJS.ProcessEnv): void {
  const database = new URL(env.DATABASE_URL ?? '');
  const endpoint = new URL(env.SNAPSHOTS_AWS_ENDPOINT_URL ?? '');
  const publicBase = `${endpoint.origin}/${TUTORIAL_SNAPSHOT_BUCKET}`;
  if (
    env.BOARDSESH_TUTORIAL_DEMO !== '1' ||
    database.protocol !== 'postgresql:' ||
    database.hostname !== '127.0.0.1' ||
    database.port !== env.TUTORIAL_POSTGRES_PORT ||
    database.username !== 'postgres' ||
    database.password !== 'password' ||
    database.pathname !== '/boardsesh_tutorial' ||
    env.READ_REPLICA_URL !== '' ||
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port !== env.TUTORIAL_S3_PORT ||
    env.SNAPSHOTS_S3_BUCKET_NAME !== TUTORIAL_SNAPSHOT_BUCKET ||
    env.SNAPSHOTS_AWS_ACCESS_KEY_ID !== 'tutorial-local' ||
    env.SNAPSHOTS_AWS_SECRET_ACCESS_KEY !== 'tutorial-local' ||
    env.SNAPSHOTS_S3_FORCE_PATH_STYLE !== 'true' ||
    env.SNAPSHOTS_DISABLE_ACL !== 'true' ||
    env.SNAPSHOTS_PUBLIC_BASE_URL !== publicBase ||
    env.SNAPSHOT_PUBLIC_BASE_URL !== publicBase ||
    env.EXPO_PUBLIC_SNAPSHOT_BASE_URL !== `${publicBase}/${TUTORIAL_SNAPSHOT_PREFIX}`
  )
    throw new Error('Tutorial snapshots require the owned local database, Moto bucket and manifest URL');
}

/** A changed catalogue/runtime, damaged file or unsafe object key always forces a real export. */
export function validTutorialSnapshotCache(
  cache: unknown,
  inputSha256: string,
  readObject: (filename: string) => Buffer,
): cache is TutorialSnapshotCache {
  if (!cache || typeof cache !== 'object') return false;
  const metadata = cache as Record<string, unknown>;
  if (metadata.formatVersion !== 1 || metadata.inputSha256 !== inputSha256 || !Array.isArray(metadata.objects))
    return false;
  if (metadata.objects.length < 2 || metadata.objects.length > 3) return false;
  const keys = new Set<string>();
  let manifests = 0;
  try {
    for (const candidate of metadata.objects) {
      if (!candidate || typeof candidate !== 'object') return false;
      const object = candidate as Record<string, unknown>;
      if (
        typeof object.key !== 'string' ||
        typeof object.filename !== 'string' ||
        object.filename !== object.key.split('/').at(-1) ||
        !/^[a-zA-Z0-9.-]+$/.test(object.filename) ||
        object.filename.includes('..') ||
        !(
          object.key === `${TUTORIAL_SNAPSHOT_PREFIX}/manifest.json` ||
          new RegExp(`^${TUTORIAL_SNAPSHOT_PREFIX}/kilter/1/[a-zA-Z0-9-]+\\.db$`).test(object.key)
        ) ||
        keys.has(object.key) ||
        !Number.isSafeInteger(object.bytes) ||
        (object.bytes as number) <= 0 ||
        typeof object.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(object.sha256) ||
        !['application/json', 'application/x-sqlite3'].includes(String(object.contentType)) ||
        (object.contentEncoding !== undefined && object.contentEncoding !== 'gzip')
      )
        return false;
      keys.add(object.key);
      if (object.key.endsWith('/manifest.json')) {
        if (object.contentType !== 'application/json' || object.contentEncoding !== undefined) return false;
        manifests++;
      } else if (object.contentType !== 'application/x-sqlite3' || object.contentEncoding !== 'gzip') return false;
      const bytes = readObject(object.filename);
      if (bytes.length !== object.bytes || tutorialSnapshotSha(bytes) !== object.sha256) return false;
    }
  } catch {
    return false;
  }
  return manifests === 1;
}
