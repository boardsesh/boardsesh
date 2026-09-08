import { describe, expect, it } from 'vitest';

import { mergeFixtureSets, parseMergeArguments, type FixtureSetForMerge } from '../screenshot-fixtures-merge';
import type { ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';

function manifest(overrides: Partial<ScreenshotFixtureManifest> = {}): ScreenshotFixtureManifest {
  return {
    formatVersion: 1,
    recordedAt: '2026-09-08T12:00:03Z',
    frozenNow: '2026-09-08T12:00:00Z',
    upstream: 'https://ws.boardsesh.com',
    accountEmail: 'test@boardsesh.com',
    accountUserId: 'user-test',
    flow: 'app-store',
    graphql: [],
    static: [],
    ...overrides,
  };
}

function graphqlEntry(operationName: string, variablesHash: string) {
  return {
    operationName,
    documentHash: `doc-${operationName}`,
    variablesHash,
    file: `graphql/${operationName}/${variablesHash}.json`,
  };
}

function staticEntry(path: string, query = '') {
  return { path, query, file: `static/${path.replaceAll('/', '_')}.jpg`, contentType: 'image/jpeg', bytes: 12 };
}

function set(label: string, entries: ReturnType<typeof graphqlEntry>[], hashes: Record<string, string>) {
  return {
    label,
    manifest: manifest({ graphql: entries }),
    fileHashes: new Map(Object.entries(hashes)),
  } satisfies FixtureSetForMerge;
}

describe('mergeFixtureSets', () => {
  it('takes the union of two disjoint shards', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    const climb = graphqlEntry('GetClimb', 'bbbb');
    const merged = mergeFixtureSets([
      set('shard-a', [profile], { [profile.file]: 'hash-profile' }),
      set('shard-b', [climb], { [climb.file]: 'hash-climb' }),
    ]);

    expect(merged.manifest.graphql.map((entry) => entry.operationName)).toEqual(['GetClimb', 'GetProfile']);
    expect(merged.sources.get(profile.file)).toBe('shard-a');
    expect(merged.sources.get(climb.file)).toBe('shard-b');
  });

  it('keeps one copy when two shards recorded the same key byte-identically', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    const merged = mergeFixtureSets([
      set('shard-a', [profile], { [profile.file]: 'same-bytes' }),
      set('shard-b', [profile], { [profile.file]: 'same-bytes' }),
    ]);

    expect(merged.manifest.graphql).toHaveLength(1);
    expect(merged.sources.get(profile.file)).toBe('shard-a');
  });

  it('fails, naming the key, when the same key was recorded differently', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    expect(() =>
      mergeFixtureSets([
        set('shard-a', [profile], { [profile.file]: 'bytes-one' }),
        set('shard-b', [profile], { [profile.file]: 'bytes-two' }),
      ]),
    ).toThrow(/GetProfile \(variables aaaa\).*shard-a.*shard-b/s);
  });

  it('fails, naming the asset, when a static key differs between shards', () => {
    const avatar = staticEntry('/static/avatars/one.jpg', 'size=64');
    const setWith = (label: string, hash: string): FixtureSetForMerge => ({
      label,
      manifest: manifest({ static: [avatar] }),
      fileHashes: new Map([[avatar.file, hash]]),
    });
    expect(() => mergeFixtureSets([setWith('shard-a', 'bytes-one'), setWith('shard-b', 'bytes-two')])).toThrow(
      /\/static\/avatars\/one\.jpg\?size=64/,
    );
  });

  it('refuses shards recorded as different accounts', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    const shardA = set('shard-a', [profile], { [profile.file]: 'same-bytes' });
    const shardB: FixtureSetForMerge = {
      label: 'shard-b',
      manifest: manifest({ graphql: [profile], accountEmail: 'marco@example.com' }),
      fileHashes: new Map([[profile.file, 'same-bytes']]),
    };
    expect(() => mergeFixtureSets([shardA, shardB])).toThrow(
      /different accounts.*test@boardsesh\.com.*marco@example\.com/s,
    );
  });

  it('refuses shards recorded against different upstreams', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    const shardA = set('shard-a', [profile], { [profile.file]: 'same-bytes' });
    const shardB: FixtureSetForMerge = {
      label: 'shard-b',
      manifest: manifest({ graphql: [profile], upstream: 'http://localhost:8080' }),
      fileHashes: new Map([[profile.file, 'same-bytes']]),
    };
    expect(() => mergeFixtureSets([shardA, shardB])).toThrow(/different upstreams/);
  });

  it('takes provenance from the first shard and sorts the merged entries', () => {
    const zulu = graphqlEntry('Zulu', 'cccc');
    const alpha = graphqlEntry('Alpha', 'dddd');
    const merged = mergeFixtureSets([
      { ...set('shard-a', [zulu], { [zulu.file]: 'h1' }), manifest: manifest({ graphql: [zulu], flow: 'app-store' }) },
      {
        ...set('shard-b', [alpha], { [alpha.file]: 'h2' }),
        manifest: manifest({ graphql: [alpha], flow: 'onboarding', recordedAt: '2026-09-09T12:00:00Z' }),
      },
    ]);

    expect(merged.manifest.flow).toBe('app-store');
    expect(merged.manifest.recordedAt).toBe('2026-09-08T12:00:03Z');
    expect(merged.manifest.graphql.map((entry) => entry.operationName)).toEqual(['Alpha', 'Zulu']);
  });

  it('fails when a manifest names a file the set does not hold', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    expect(() => mergeFixtureSets([set('shard-a', [profile], {})])).toThrow(/missing from the set/);
  });

  it('refuses to merge nothing', () => {
    expect(() => mergeFixtureSets([])).toThrow(/at least one recorded fixture directory/);
  });
});

describe('parseMergeArguments', () => {
  it('resolves relative inputs against the repo root and defaults --out', () => {
    const options = parseMergeArguments(['--', 'artifacts/shard-a', 'artifacts/shard-b']);
    expect(options.outDir.endsWith('/packages/mobile/screenshot-fixtures')).toBe(true);
    expect(options.inputDirs).toHaveLength(2);
    expect(options.inputDirs[0].endsWith('/artifacts/shard-a')).toBe(true);
  });

  it('requires at least one input and rejects an output that is also an input', () => {
    expect(() => parseMergeArguments([])).toThrow(/at least one input directory/);
    expect(() => parseMergeArguments(['--out', '/tmp/merged', '/tmp/merged'])).toThrow(/also one of the inputs/);
  });
});
