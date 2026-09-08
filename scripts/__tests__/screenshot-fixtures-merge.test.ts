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

  it('refuses shards recorded from different flows', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    const shardA = set('shard-a', [profile], { [profile.file]: 'same-bytes' });
    const shardB: FixtureSetForMerge = {
      label: 'shard-b',
      manifest: manifest({ graphql: [profile], flow: 'onboarding' }),
      fileHashes: new Map([[profile.file, 'same-bytes']]),
    };
    expect(() => mergeFixtureSets([shardA, shardB])).toThrow(/different flows.*app-store.*onboarding/s);
  });

  it('refuses shards recorded under different account ids, even with the same email', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    const shardA = set('shard-a', [profile], { [profile.file]: 'same-bytes' });
    const shardB: FixtureSetForMerge = {
      label: 'shard-b',
      manifest: manifest({ graphql: [profile], accountUserId: 'user-other' }),
      fileHashes: new Map([[profile.file, 'same-bytes']]),
    };
    expect(() => mergeFixtureSets([shardA, shardB])).toThrow(/different accounts.*user-test.*user-other/s);
  });

  it('refuses a shard that never signed in, naming it', () => {
    const profile = graphqlEntry('GetProfile', 'aaaa');
    const shardA = set('shard-a', [profile], { [profile.file]: 'same-bytes' });
    const shardB: FixtureSetForMerge = {
      label: 'shard-b',
      manifest: manifest({ graphql: [profile], accountUserId: '' }),
      fileHashes: new Map([[profile.file, 'same-bytes']]),
    };
    expect(() => mergeFixtureSets([shardA, shardB])).toThrow(/shard shard-b never signed in/);
  });

  it('takes provenance (account, upstream, flow) from the first shard and sorts the merged entries', () => {
    const zulu = graphqlEntry('Zulu', 'cccc');
    const alpha = graphqlEntry('Alpha', 'dddd');
    const merged = mergeFixtureSets([
      set('shard-a', [zulu], { [zulu.file]: 'h1' }),
      set('shard-b', [alpha], { [alpha.file]: 'h2' }),
    ]);

    expect(merged.manifest.flow).toBe('app-store');
    expect(merged.manifest.accountEmail).toBe('test@boardsesh.com');
    expect(merged.manifest.graphql.map((entry) => entry.operationName)).toEqual(['Alpha', 'Zulu']);
  });

  it('takes the MAXIMUM frozenNow and recordedAt across every input, not the first', () => {
    const early = graphqlEntry('Early', 'aaaa');
    const mid = graphqlEntry('Mid', 'bbbb');
    const late = graphqlEntry('Late', 'cccc');
    const merged = mergeFixtureSets([
      {
        ...set('shard-early', [early], { [early.file]: 'h1' }),
        manifest: manifest({
          graphql: [early],
          frozenNow: '2026-09-08T09:00:00Z',
          recordedAt: '2026-09-08T09:00:03Z',
        }),
      },
      {
        ...set('shard-late', [late], { [late.file]: 'h3' }),
        manifest: manifest({
          graphql: [late],
          frozenNow: '2026-09-08T12:00:00Z',
          recordedAt: '2026-09-08T12:00:03Z',
        }),
      },
      {
        ...set('shard-mid', [mid], { [mid.file]: 'h2' }),
        manifest: manifest({
          graphql: [mid],
          frozenNow: '2026-09-08T10:00:00Z',
          recordedAt: '2026-09-08T10:00:03Z',
        }),
      },
    ]);

    // The latest shard's instant wins regardless of input order.
    expect(merged.manifest.frozenNow).toBe('2026-09-08T12:00:00Z');
    expect(merged.manifest.recordedAt).toBe('2026-09-08T12:00:03Z');
  });

  it('re-derives an input whose own manifest.frozenNow predates one of its own entries (belt and braces)', () => {
    const stale = graphqlEntry('GetSessionGroupedFeed', 'aaaa');
    const shard: FixtureSetForMerge = {
      label: 'shard-stale',
      manifest: manifest({ graphql: [stale], frozenNow: '2026-09-08T13:07:50Z' }),
      fileHashes: new Map([[stale.file, 'hash']]),
      // Recorded AFTER the manifest's own frozenNow — a pre-fix or hand-edited
      // set. The merge must not trust manifest.frozenNow blindly here.
      graphqlRecordedAt: new Map([[stale.file, '2026-09-08T13:18:23.456Z']]),
    };
    const merged = mergeFixtureSets([shard]);
    expect(Date.parse(merged.manifest.frozenNow)).toBeGreaterThan(Date.parse('2026-09-08T13:18:24.456Z'));
  });

  it('leaves frozenNow alone when every entry predates it, even with graphqlRecordedAt present', () => {
    const clean = graphqlEntry('GetProfile', 'aaaa');
    const shard: FixtureSetForMerge = {
      label: 'shard-clean',
      manifest: manifest({ graphql: [clean], frozenNow: '2026-09-08T13:07:50Z' }),
      fileHashes: new Map([[clean.file, 'hash']]),
      graphqlRecordedAt: new Map([[clean.file, '2026-09-08T13:00:00Z']]),
    };
    const merged = mergeFixtureSets([shard]);
    expect(merged.manifest.frozenNow).toBe('2026-09-08T13:07:50Z');
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
