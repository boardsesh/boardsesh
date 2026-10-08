/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureSnapshotArchive } from '../lib/screenshot-fixture-archive';
import { decodeFixtureSnapshot, FIXTURE_SNAPSHOT_REFERENCE } from '../lib/screenshot-fixture-snapshot';
import type { GraphqlFixtureFile, ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function recording(overrides: Partial<GraphqlFixtureFile> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-archive-'));
  directories.push(directory);
  const fixture: GraphqlFixtureFile = {
    formatVersion: 1,
    operationName: 'GetProfile',
    query: 'query GetProfile { profile { id } }',
    documentHash: 'document-hash',
    variablesHash: 'variables-hash',
    variables: {},
    response: { data: { profile: { id: 'own-user' } } },
    status: 200,
    recordedAt: '2026-10-08T12:00:00Z',
    upstream: 'https://ws.boardsesh.com',
    ...overrides,
  };
  const manifest: ScreenshotFixtureManifest = {
    formatVersion: 1,
    recordedAt: fixture.recordedAt,
    frozenNow: fixture.recordedAt,
    upstream: fixture.upstream,
    accountEmail: 'test@boardsesh.com',
    accountUserId: 'own-user',
    flow: 'app-store',
    graphql: [
      {
        operationName: fixture.operationName,
        documentHash: fixture.documentHash,
        variablesHash: fixture.variablesHash,
        file: 'graphql/GetProfile/recording.json',
      },
    ],
    static: [],
  };
  mkdirSync(join(directory, 'graphql/GetProfile'), { recursive: true });
  writeFileSync(join(directory, 'graphql/GetProfile/recording.json'), JSON.stringify(fixture));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

describe('sanitized offline fixture archives', () => {
  it('packages the manifest-listed recording bytes without side files or changing the pinned reference', () => {
    const directory = recording();
    writeFileSync(join(directory, 'credentials.env'), 'SECRET=must-never-publish');
    const pinnedBefore = readFileSync(FIXTURE_SNAPSHOT_REFERENCE);
    const { compressed, reference } = createFixtureSnapshotArchive(directory);
    const files = decodeFixtureSnapshot(compressed, reference);
    expect([...files.keys()]).toEqual(['manifest.json', 'graphql/GetProfile/recording.json']);
    expect(files.get('graphql/GetProfile/recording.json')).toEqual(
      readFileSync(join(directory, 'graphql/GetProfile/recording.json')),
    );
    expect(readFileSync(FIXTURE_SNAPSHOT_REFERENCE)).toEqual(pinnedBefore);
    expect(existsSync(join(directory, 'credentials.env'))).toBe(true);
  });

  it('exports through the actual offline CLI with no storage credentials and leaves the pin unchanged', () => {
    const directory = recording();
    const archive = join(directory, 'candidate.json.gz');
    const pinnedBefore = readFileSync(FIXTURE_SNAPSHOT_REFERENCE);
    const output = execFileSync(
      'vp',
      ['exec', 'tsx', 'scripts/screenshot-fixtures-publish.ts', '--archive', archive, directory],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DEV_S3_BUCKET_NAME: '',
          DEV_AWS_ENDPOINT_URL: '',
          DEV_PUBLIC_BASE_URL: '',
          DEV_AWS_ACCESS_KEY_ID: '',
          DEV_AWS_SECRET_ACCESS_KEY: '',
        },
      },
    );
    const metadata = JSON.parse(output) as { sha256: string; bytes: number; files: number };
    expect(decodeFixtureSnapshot(readFileSync(archive), { ...metadata, version: 1, url: '' }).size).toBe(2);
    expect(readFileSync(FIXTURE_SNAPSHOT_REFERENCE)).toEqual(pinnedBefore);
  });

  it('rejects live credentials in recorded variables before any archive is exported', () => {
    expect(() => createFixtureSnapshotArchive(recording({ variables: { password: 'real-secret' } }))).toThrow(
      'unsanitized',
    );
  });

  it('rejects an unapproved climber identity while allowing the recorded account identity', () => {
    const directory = recording({
      response: {
        data: { profile: { id: 'other-user', username: 'Real Climber', avatarUrl: 'https://example.com/person.jpg' } },
      },
    });
    expect(() => createFixtureSnapshotArchive(directory)).toThrow('unsanitized');
    expect(() =>
      createFixtureSnapshotArchive(
        recording({ response: { data: { profile: { id: 'own-user', username: 'Test User' } } } }),
      ),
    ).not.toThrow();
  });

  it('rejects manifest paths outside fixture content and missing recorded bytes', () => {
    const directory = recording();
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    manifest.graphql[0].file = '../credentials.env';
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    expect(() => createFixtureSnapshotArchive(directory)).toThrow();
    manifest.graphql[0].file = 'graphql/GetProfile/missing.json';
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    expect(() => createFixtureSnapshotArchive(directory)).toThrow('ENOENT');
  });
});
