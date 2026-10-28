/// <reference types="node" />

import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_CLIMBS_COUNT } from '../../packages/shared/graphql/src/operations/climb-search';
import { main, recordIosCampaignCounts } from '../record-ios-campaign-counts';
import { createScreenshotBackend, readScreenshotFixtureManifest } from '../lib/screenshot-backend';
import { createFixtureSnapshotArchive } from '../lib/screenshot-fixture-archive';
import * as snapshots from '../lib/screenshot-fixture-snapshot';
import {
  emptyManifest,
  graphqlFixtureKey,
  type ScreenshotFixtureManifest,
  type GraphqlFixtureFile,
} from '../lib/screenshot-fixtures';

const UPSTREAM = 'https://ws.boardsesh.com';
const ACCOUNT = '11111111-2222-4333-8444-555555555555';
const PUBLIC_SCOPES = [
  { boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: '26,27,28,29', angle: 35 },
  { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 40 },
  { boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 40 },
  { boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 },
  { boardName: 'decoy', layoutId: 2, sizeId: 1, setIds: '2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20', angle: 40 },
  { boardName: 'grasshopper', layoutId: 1, sizeId: 4, setIds: '1,2,3,4,5,6', angle: 40 },
];
const SPRAY_SCOPE = { boardName: 'spray', layoutId: 47, sizeId: 47, setIds: '1', angle: 40 };
const inputFor = (scope: (typeof PUBLIC_SCOPES)[number]) => ({
  ...scope,
  sortBy: 'ascents',
  sortOrder: 'desc',
  boulders: true,
});
const SEARCH_QUERY =
  'query SearchClimbs($input: ClimbSearchInput!) { searchClimbs(input: $input) { climbs { uuid } hasMore } }';

let directory: string;
let baseDirectory: string;
let sprayDirectory: string;
let outputDirectory: string;
let upstream: Server;
let baseArchive: ReturnType<typeof createFixtureSnapshotArchive>;
let sprayArchive: ReturnType<typeof createFixtureSnapshotArchive>;
let sentQueries: Array<{ body: unknown; authorization: string | undefined }>;
let graphqlStatus: number;
let responseOverride: unknown;

function addFixture(
  root: string,
  manifest: ScreenshotFixtureManifest,
  operationName: string,
  query: string,
  variables: unknown,
  response: unknown,
): void {
  const key = graphqlFixtureKey({ operationName, query, variables }, (text) =>
    snapshots.snapshotHash(Buffer.from(text)),
  );
  const file = `graphql/${operationName}/${key.variablesHash.slice(0, 16)}.json`;
  const fixture: GraphqlFixtureFile = {
    formatVersion: 1,
    ...key,
    query,
    variables,
    response,
    status: 200,
    recordedAt: manifest.recordedAt,
    upstream: manifest.upstream,
  };
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), `${JSON.stringify(fixture, null, 2)}\n`);
  manifest.graphql.push({ ...key, file });
}

function buildSources(): void {
  const fields = {
    recordedAt: '2026-10-14T07:00:00Z',
    frozenNow: '2026-10-14T07:00:02Z',
    upstream: UPSTREAM,
    accountEmail: 'shots@boardsesh.com',
    accountUserId: ACCOUNT,
  };
  const base = emptyManifest({ ...fields, flow: 'app-store-campaign' });
  base.capture = {
    sharedSessionId: '00000000-0000-4000-8000-000000000101',
    boards: ['Kilter', 'Tension', 'MoonBoard', 'Woods', 'Decoy', 'Grasshopper', 'Spraywall'],
  };
  for (const scope of [...PUBLIC_SCOPES, SPRAY_SCOPE])
    addFixture(
      baseDirectory,
      base,
      'SearchClimbs',
      SEARCH_QUERY,
      { input: { ...inputFor(scope), page: 0, pageSize: 6 } },
      {
        data: {
          searchClimbs: {
            climbs: [{ uuid: 'first-climb' }, { uuid: 'second-climb' }, { uuid: 'third-climb' }],
            hasMore: scope.boardName !== 'spray',
          },
        },
      },
    );
  addFixture(baseDirectory, base, 'GetProfile', 'query GetProfile { profile { id } }', {}, { data: { profile: null } });
  mkdirSync(join(baseDirectory, 'static'));
  writeFileSync(join(baseDirectory, 'static/photo.jpg'), 'original-photo');
  base.static = [{ path: '/photo.jpg', query: '', file: 'static/photo.jpg', contentType: 'image/jpeg', bytes: 14 }];
  writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(base));

  const spray = emptyManifest({ ...fields, flow: 'app-store-cpp' });
  spray.capture = {
    sharedSessionId: base.capture.sharedSessionId,
    boards: ['Spraywall', 'Other wall'],
    cpp: { target: 'spray', boardReadyText: {}, scenes: {} },
  };
  addFixture(
    sprayDirectory,
    spray,
    'SearchClimbsCount',
    SEARCH_CLIMBS_COUNT,
    { input: { ...inputFor(SPRAY_SCOPE), page: 0, pageSize: 1 } },
    { data: { searchClimbs: { totalCount: 3 } } },
  );
  writeFileSync(join(sprayDirectory, 'manifest.json'), JSON.stringify(spray));
}

function refreshSourceArchives(): void {
  baseArchive = createFixtureSnapshotArchive(baseDirectory);
  sprayArchive = createFixtureSnapshotArchive(sprayDirectory);
}

const refresh = (factory?: typeof createScreenshotBackend) =>
  recordIosCampaignCounts(
    { baseArchive: baseArchive.compressed, sprayArchive: sprayArchive.compressed, outputDirectory },
    factory,
  );

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'campaign-counts-test-'));
  baseDirectory = join(directory, 'base');
  sprayDirectory = join(directory, 'spray');
  outputDirectory = join(directory, 'candidate');
  mkdirSync(baseDirectory);
  mkdirSync(sprayDirectory);
  buildSources();
  refreshSourceArchives();
  vi.spyOn(snapshots, 'readFixtureSnapshotReference').mockImplementation((filename) =>
    filename?.endsWith('/spray.json')
      ? { ...sprayArchive.reference, url: 'https://example.com/spray.gz' }
      : { ...baseArchive.reference, url: 'https://example.com/base.gz' },
  );
  sentQueries = [];
  graphqlStatus = 200;
  responseOverride = undefined;
  upstream = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      sentQueries.push({ body: JSON.parse(body), authorization: request.headers.authorization });
      response.statusCode = graphqlStatus;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(responseOverride ?? { data: { searchClimbs: { totalCount: 100 + sentQueries.length } } }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No upstream socket');
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return originalFetch(url.startsWith(UPSTREAM) ? url.replace(UPSTREAM, origin) : input, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  rmSync(directory, { recursive: true, force: true });
});

describe('bounded public count extension with immutable private owner evidence', () => {
  it('records exactly six anonymous current queries, preserves the original owner count and every base byte, then replays all seven', async () => {
    const originalFiles = snapshots.decodeFixtureSnapshot(baseArchive.compressed, baseArchive.reference);
    const privateFiles = snapshots.decodeFixtureSnapshot(sprayArchive.compressed, sprayArchive.reference);
    const pins = [
      'app-stores/apple/campaign-counts-base.json',
      snapshots.IOS_CAMPAIGN_FIXTURE_REFERENCE,
      snapshots.FIXTURE_SNAPSHOT_REFERENCE,
      ...['kilter', 'tension', 'moonboard', 'spray'].map((target) => `app-stores/apple/cpp-fixtures/${target}.json`),
    ].map((file) => [file, readFileSync(file)] as const);
    const result = await refresh();
    expect(sentQueries).toEqual(
      PUBLIC_SCOPES.map((scope) => ({
        body: { operationName: 'SearchClimbsCount', query: SEARCH_CLIMBS_COUNT, variables: { input: inputFor(scope) } },
        authorization: undefined,
      })),
    );
    const candidate = readScreenshotFixtureManifest(join(outputDirectory, 'merged'))!;
    const original = readScreenshotFixtureManifest(baseDirectory)!;
    expect({ ...candidate, graphql: original.graphql }).toEqual(original);
    expect(candidate.graphql).toHaveLength(original.graphql.length + 7);
    const decoded = snapshots.decodeFixtureSnapshot(
      readFileSync(join(result.exportDirectory, `ios-campaign-${result.reference.sha256}.json.gz`)),
      result.reference,
    );
    for (const [file, bytes] of originalFiles) if (file !== 'manifest.json') expect(decoded.get(file)).toEqual(bytes);
    for (const [file, bytes] of privateFiles) if (file !== 'manifest.json') expect(decoded.get(file)).toEqual(bytes);
    for (const [file, bytes] of pins) expect(readFileSync(file)).toEqual(bytes);
    expect(result.proof).toMatchObject({
      unchangedGraphqlFiles: 8,
      unchangedStaticFiles: 1,
      captureMetadataPreserved: true,
      accountMetadataPreserved: true,
      frozenNowPreserved: true,
      currentDocumentReplayHits: 7,
      currentDocumentReplayMisses: 0,
      fullNativeReplayRequired: true,
    });
    expect(result.proof.counts.map((count) => count.totalCount)).toEqual([101, 102, 103, 104, 105, 106, 3]);
    expect(result.proof.counts[6]).toMatchObject({
      source: 'original-same-account-spray-cpp',
      recordedAt: '2026-10-14T07:00:00Z',
      variables: { input: { ...inputFor(SPRAY_SCOPE), page: 0, pageSize: 1 } },
    });
    expect(readFileSync(join(result.exportDirectory, 'campaign.json'), 'utf8')).toContain(result.reference.sha256);
  });

  it.each([
    'foreign-account',
    'foreign-upstream',
    'changed-filter',
    'changed-private-scope',
    'changed-owner-count',
    'existing-count',
  ])('rejects %s before any public request', async (failure) => {
    const base = readScreenshotFixtureManifest(baseDirectory)!;
    const spray = readScreenshotFixtureManifest(sprayDirectory)!;
    if (failure === 'foreign-account') spray.accountUserId = 'foreign-account';
    if (failure === 'foreign-upstream') base.upstream = 'https://unapproved.example';
    if (failure === 'changed-filter') base.graphql.splice(0, 1);
    if (failure === 'changed-private-scope' || failure === 'changed-owner-count') {
      const fixture = JSON.parse(
        readFileSync(join(sprayDirectory, spray.graphql[0].file), 'utf8'),
      ) as GraphqlFixtureFile;
      if (failure === 'changed-private-scope') {
        const variables = fixture.variables as { input: Record<string, unknown> };
        variables.input.minGrade = 15;
        fixture.variables = variables;
      } else fixture.response = { data: { searchClimbs: { totalCount: 0 } } };
      writeFileSync(join(sprayDirectory, spray.graphql[0].file), JSON.stringify(fixture));
    }
    if (failure === 'existing-count')
      addFixture(
        baseDirectory,
        base,
        'SearchClimbsCount',
        SEARCH_CLIMBS_COUNT,
        { input: inputFor(PUBLIC_SCOPES[0]) },
        { data: { searchClimbs: { totalCount: 100 } } },
      );
    writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(base));
    writeFileSync(join(sprayDirectory, 'manifest.json'), JSON.stringify(spray));
    refreshSourceArchives();
    await expect(refresh()).rejects.toThrow();
    expect(sentQueries).toHaveLength(0);
    expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
  });

  it.each([-1, 1.5, null, '100', undefined])(
    'rejects invalid live count %s instead of inventing a value',
    async (totalCount) => {
      responseOverride = { data: { searchClimbs: { totalCount } } };
      await expect(refresh()).rejects.toThrow('nonnegative integer');
      expect(sentQueries).toHaveLength(1);
      expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    },
  );

  it.each([0, 3, 300])('rejects genuine public count %s below recorded pagination coverage', async (totalCount) => {
    const base = readScreenshotFixtureManifest(baseDirectory)!;
    addFixture(
      baseDirectory,
      base,
      'SearchClimbs',
      SEARCH_QUERY,
      { input: { ...inputFor(PUBLIC_SCOPES[0]), page: 2, pageSize: 100 } },
      {
        data: {
          searchClimbs: {
            climbs: Array.from({ length: 100 }, (_, index) => ({ uuid: `recorded-${index}` })),
            hasMore: true,
          },
        },
      },
    );
    writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(base));
    refreshSourceArchives();
    responseOverride = { data: { searchClimbs: { totalCount } } };
    await expect(refresh()).rejects.toThrow('contradicts recorded search coverage');
    expect(sentQueries).toHaveLength(1);
    expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
  });

  it('accepts the exact lower boundary proved by a recorded page with more results', async () => {
    const base = readScreenshotFixtureManifest(baseDirectory)!;
    addFixture(
      baseDirectory,
      base,
      'SearchClimbs',
      SEARCH_QUERY,
      { input: { ...inputFor(PUBLIC_SCOPES[0]), page: 2, pageSize: 100 } },
      {
        data: {
          searchClimbs: {
            climbs: Array.from({ length: 100 }, (_, index) => ({ uuid: `recorded-${index}` })),
            hasMore: true,
          },
        },
      },
    );
    writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(base));
    refreshSourceArchives();
    responseOverride = { data: { searchClimbs: { totalCount: 301 } } };
    const result = await refresh();
    expect(result.proof.counts[0]).toMatchObject({ totalCount: 301, recordedCountFloor: 301 });
  });

  it('does not treat an empty later page as proof that its offset exists', async () => {
    const base = readScreenshotFixtureManifest(baseDirectory)!;
    addFixture(
      baseDirectory,
      base,
      'SearchClimbs',
      SEARCH_QUERY,
      { input: { ...inputFor(PUBLIC_SCOPES[0]), page: 2, pageSize: 100 } },
      { data: { searchClimbs: { climbs: [], hasMore: false } } },
    );
    writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(base));
    refreshSourceArchives();
    responseOverride = { data: { searchClimbs: { totalCount: 4 } } };
    const result = await refresh();
    expect(result.proof.counts[0]).toMatchObject({ totalCount: 4, recordedCountFloor: 4 });
  });

  it.each(['http-error', 'graphql-error', 'extra-field'])(
    'rejects %s without exporting a candidate',
    async (failure) => {
      if (failure === 'http-error') graphqlStatus = 503;
      responseOverride =
        failure === 'graphql-error'
          ? { data: { searchClimbs: { totalCount: 100 } }, errors: [{ message: 'failed' }] }
          : failure === 'extra-field'
            ? { data: { searchClimbs: { totalCount: 100, climbs: [] } } }
            : { error: 'failed' };
      await expect(refresh()).rejects.toThrow();
      expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    },
  );

  it('refuses corrupted archive bytes and existing output without changing them', async () => {
    const corrupted = Buffer.from(baseArchive.compressed);
    corrupted[0] ^= 1;
    await expect(
      recordIosCampaignCounts({ baseArchive: corrupted, sprayArchive: sprayArchive.compressed, outputDirectory }),
    ).rejects.toThrow('checksum');
    mkdirSync(outputDirectory);
    writeFileSync(join(outputDirectory, 'keep'), 'existing work');
    await expect(refresh()).rejects.toThrow('already exists');
    expect(readFileSync(join(outputDirectory, 'keep'), 'utf8')).toBe('existing work');
    expect(sentQueries).toHaveLength(0);
  });

  it.each(['original-file', 'manifest'])(
    'refuses an altered candidate %s even if all seven count requests replay',
    async (changed) => {
      const corruptingFactory: typeof createScreenshotBackend = (options) => {
        if (options.mode === 'replay') {
          if (changed === 'original-file')
            writeFileSync(join(options.fixturesDir, 'static/photo.jpg'), 'changed photo!');
          else {
            const manifest = readScreenshotFixtureManifest(options.fixturesDir)!;
            manifest.accountUserId = 'foreign-account';
            writeFileSync(join(options.fixturesDir, 'manifest.json'), JSON.stringify(manifest));
          }
        }
        return createScreenshotBackend(options);
      };
      await expect(refresh(corruptingFactory)).rejects.toThrow(
        changed === 'original-file' ? 'changed an original file' : 'manifest or provenance',
      );
      expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    },
  );

  it('accepts only an output directory, never query, upstream, or credential overrides', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    await expect(main(['--query', 'mutation DeleteSomething'])).rejects.toThrow('Usage');
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the CLI anchored to the original base after the active listing selects an extended candidate', async () => {
    const activeCandidate = await refresh();
    const baseReference = { ...baseArchive.reference, url: 'https://example.com/original-base.gz' };
    const sprayReference = { ...sprayArchive.reference, url: 'https://example.com/spray.gz' };
    vi.mocked(snapshots.readFixtureSnapshotReference).mockImplementation((filename) => {
      if (filename === snapshots.IOS_CAMPAIGN_FIXTURE_REFERENCE) return activeCandidate.reference;
      if (filename?.endsWith('/campaign-counts-base.json')) return baseReference;
      if (filename?.endsWith('/spray.json')) return sprayReference;
      throw new Error('Unexpected reference');
    });
    const fetchedReferences: string[] = [];
    vi.spyOn(snapshots, 'ensureScreenshotFixtures').mockImplementation(async (reference) => {
      if (!reference) throw new Error('Expected explicit immutable reference');
      fetchedReferences.push(reference.sha256);
      const original = reference.sha256 === baseReference.sha256;
      const sourceDirectory = original ? baseDirectory : sprayDirectory;
      const bytes = original ? baseArchive.compressed : sprayArchive.compressed;
      expect(reference.sha256).toBe(original ? baseReference.sha256 : sprayReference.sha256);
      writeFileSync(join(dirname(sourceDirectory), `${reference.sha256}.json.gz`), bytes);
      return sourceDirectory;
    });
    outputDirectory = join(directory, 'second-candidate');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main([outputDirectory]);
    expect(fetchedReferences).toEqual([baseReference.sha256, sprayReference.sha256]);
    expect(fetchedReferences).not.toContain(activeCandidate.reference.sha256);
    const proof = JSON.parse(readFileSync(join(outputDirectory, 'export/campaign.proof.json'), 'utf8')) as {
      baseArchiveSha256: string;
      unchangedGraphqlFiles: number;
    };
    expect(proof.baseArchiveSha256).toBe(baseReference.sha256);
    expect(proof.unchangedGraphqlFiles).toBe(8);
  });
});
