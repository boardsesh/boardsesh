import { describe, expect, it } from 'vitest';
import { tutorialDemoEnvironment } from '../lib/instructional-video/demo';
import {
  assertTutorialSnapshotEnvironment,
  TUTORIAL_SNAPSHOT_PREFIX,
  tutorialSnapshotSha,
  validTutorialSnapshotCache,
} from '../lib/instructional-video/snapshots';

const ports = { postgres: 15433, redis: 16380, s3: 15001, backend: 18089 };

describe('local tutorial snapshot isolation and cache', () => {
  it('derives every snapshot target from owned ports and excludes inherited production URLs/credentials', () => {
    const environment = tutorialDemoEnvironment(ports, {
      EXPO_PUBLIC_SNAPSHOT_BASE_URL: 'https://production/board-snapshots',
      SNAPSHOTS_AWS_ENDPOINT_URL: 'https://production-r2',
      SNAPSHOTS_AWS_ACCESS_KEY_ID: 'production',
      SNAPSHOTS_AWS_SECRET_ACCESS_KEY: 'production',
      SNAPSHOT_PUBLIC_BASE_URL: 'https://production',
    });
    expect(() => assertTutorialSnapshotEnvironment(environment)).not.toThrow();
    expect(environment.EXPO_PUBLIC_SNAPSHOT_BASE_URL).toBe(
      `http://127.0.0.1:15001/tutorial-snapshots/${TUTORIAL_SNAPSHOT_PREFIX}`,
    );
    expect(environment.SNAPSHOTS_AWS_SECRET_ACCESS_KEY).toBe('tutorial-local');
    expect(environment.SNAPSHOTS_DISABLE_ACL).toBe('true');
  });

  it.each([
    ['DATABASE_URL', 'postgresql://postgres:password@127.0.0.1:5432/boardsesh_tutorial'],
    ['DATABASE_URL', 'postgresql://postgres:password@127.0.0.1:15433/main'],
    ['READ_REPLICA_URL', 'postgresql://replica/boardsesh_tutorial'],
    ['SNAPSHOTS_S3_BUCKET_NAME', 'tutorial-private'],
    ['SNAPSHOTS_AWS_ENDPOINT_URL', 'https://production-r2'],
    ['SNAPSHOTS_AWS_SECRET_ACCESS_KEY', 'production'],
    ['SNAPSHOTS_DISABLE_ACL', 'false'],
    ['EXPO_PUBLIC_SNAPSHOT_BASE_URL', 'https://production/board-snapshots'],
  ])('rejects a mismatched %s before any client can be created', (name, configured) => {
    expect(() =>
      assertTutorialSnapshotEnvironment({ ...tutorialDemoEnvironment(ports, {}), [name]: configured }),
    ).toThrow('owned local database');
  });

  const artifact = Buffer.from('compressed test fixture bytes');
  const manifest = Buffer.from('{"formatVersion":2}');
  const cache = {
    formatVersion: 1,
    inputSha256: 'input-identity',
    objects: [
      {
        key: `${TUTORIAL_SNAPSHOT_PREFIX}/kilter/1/2026-10-01.db`,
        filename: '2026-10-01.db',
        bytes: artifact.length,
        sha256: tutorialSnapshotSha(artifact),
        contentType: 'application/x-sqlite3',
        contentEncoding: 'gzip',
      },
      {
        key: `${TUTORIAL_SNAPSHOT_PREFIX}/manifest.json`,
        filename: 'manifest.json',
        bytes: manifest.length,
        sha256: tutorialSnapshotSha(manifest),
        contentType: 'application/json',
      },
    ],
  };
  const readObject = (filename: string) => (filename === 'manifest.json' ? manifest : artifact);

  it('accepts only current input identities with intact stored object hashes and bytes', () => {
    expect(validTutorialSnapshotCache(cache, 'input-identity', readObject)).toBe(true);
    expect(validTutorialSnapshotCache(cache, 'changed-catalogue', readObject)).toBe(false);
    expect(validTutorialSnapshotCache(cache, 'input-identity', () => Buffer.from('damaged'))).toBe(false);
    expect(
      validTutorialSnapshotCache(cache, 'input-identity', () => {
        throw new Error('File missing');
      }),
    ).toBe(false);
  });

  it('rejects a private/outside key, directory traversal, duplicate artifact or false encoding', () => {
    for (const overrides of [
      { key: 'spray-walls/private.jpg' },
      { filename: '../2026-10-01.db' },
      { contentEncoding: undefined },
      { contentType: 'text/html' },
      { bytes: artifact.length + 1 },
    ])
      expect(
        validTutorialSnapshotCache(
          { ...cache, objects: [{ ...cache.objects[0], ...overrides }, cache.objects[1]] },
          'input-identity',
          readObject,
        ),
      ).toBe(false);
    expect(
      validTutorialSnapshotCache(
        { ...cache, objects: [cache.objects[0], cache.objects[0], cache.objects[1]] },
        'input-identity',
        readObject,
      ),
    ).toBe(false);
  });
});
