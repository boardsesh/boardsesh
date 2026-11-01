/// <reference types="node" />

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEARCH_CLIMBS_COUNT } from '../packages/shared/graphql/src/operations/climb-search';
import { createScreenshotBackend, readScreenshotFixtureManifest } from './lib/screenshot-backend';
import { createFixtureSnapshotArchive } from './lib/screenshot-fixture-archive';
import {
  decodeFixtureSnapshot,
  ensureScreenshotFixtures,
  FIXTURE_SNAPSHOT_REFERENCE,
  IOS_CAMPAIGN_FIXTURE_REFERENCE,
  readFixtureSnapshotReference,
  snapshotHash,
} from './lib/screenshot-fixture-snapshot';
import {
  canonicalJson,
  graphqlFixtureKey,
  sortManifestEntries,
  startOfSecondIso,
  validateScreenshotFixtureManifest,
  type GraphqlFixtureFile,
  type GraphqlManifestEntry,
} from './lib/screenshot-fixtures';

const UPSTREAM = 'https://ws.boardsesh.com';
const OPERATION = 'SearchClimbsCount';
const CPP_ROOT = resolve('app-stores/apple/cpp-fixtures');
const SPRAY_REFERENCE = join(CPP_ROOT, 'spray.json');
const COUNT_BASE_REFERENCE = resolve('app-stores/apple/campaign-counts-base.json');
const PIN_FILES = [
  COUNT_BASE_REFERENCE,
  IOS_CAMPAIGN_FIXTURE_REFERENCE,
  FIXTURE_SNAPSHOT_REFERENCE,
  ...['kilter', 'tension', 'moonboard', 'spray'].map((target) => join(CPP_ROOT, `${target}.json`)),
];

// These are the six public catalogue scopes in the pinned campaign. Never send
// the seventh, private Spraywall scope anonymously: its owner sees more climbs.
const PUBLIC_SCOPES = [
  { boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: '26,27,28,29', angle: 35 },
  { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 40 },
  { boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 40 },
  { boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 },
  { boardName: 'decoy', layoutId: 2, sizeId: 1, setIds: '2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20', angle: 40 },
  { boardName: 'grasshopper', layoutId: 1, sizeId: 4, setIds: '1,2,3,4,5,6', angle: 40 },
] as const;
const SPRAY_SCOPE = { boardName: 'spray', layoutId: 47, sizeId: 47, setIds: '1', angle: 40 } as const;
const countInput = (scope: (typeof PUBLIC_SCOPES)[number] | typeof SPRAY_SCOPE) => ({
  ...scope,
  sortBy: 'ascents',
  sortOrder: 'desc',
  boulders: true,
});

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function countResponse(response: unknown): number {
  if (
    !isRecord(response) ||
    Object.keys(response).join() !== 'data' ||
    !isRecord(response.data) ||
    Object.keys(response.data).join() !== 'searchClimbs' ||
    !isRecord(response.data.searchClimbs) ||
    Object.keys(response.data.searchClimbs).join() !== 'totalCount' ||
    !Number.isSafeInteger(response.data.searchClimbs.totalCount) ||
    (response.data.searchClimbs.totalCount as number) < 0
  )
    throw new Error('Expected one genuine nonnegative integer count without errors or extra fields');
  return response.data.searchClimbs.totalCount as number;
}

const fixtureKey = (fixture: { operationName: string; query: string; variables: unknown }) =>
  graphqlFixtureKey(fixture, (text) => snapshotHash(Buffer.from(text)));

/** Validate every indexed fixture before considering its response as evidence. */
function readSource(files: Map<string, Buffer>) {
  const validation = validateScreenshotFixtureManifest(JSON.parse(files.get('manifest.json')!.toString()));
  if (!validation.ok) throw new Error('Invalid source manifest');
  const manifest = validation.manifest;
  const fixtures = manifest.graphql.map((entry) => {
    const bytes = files.get(entry.file);
    if (!bytes) throw new Error('Missing source fixture');
    const fixture = JSON.parse(bytes.toString()) as GraphqlFixtureFile;
    const key = fixtureKey(fixture);
    if (
      fixture.status !== 200 ||
      !Number.isFinite(Date.parse(fixture.recordedAt)) ||
      fixture.operationName !== entry.operationName ||
      fixture.documentHash !== entry.documentHash ||
      fixture.variablesHash !== entry.variablesHash ||
      key.documentHash !== entry.documentHash ||
      key.variablesHash !== entry.variablesHash
    )
      throw new Error('Invalid source fixture identity');
    return { entry, fixture, bytes };
  });
  if (files.size !== 1 + manifest.graphql.length + manifest.static.length) throw new Error('Unexpected source files');
  for (const entry of manifest.static)
    if (files.get(entry.file)?.length !== entry.bytes) throw new Error('Invalid source static asset');
  return { manifest, fixtures };
}

/** Recorded offsets and hasMore prove a lower bound, never an invented total. */
function recordedCountFloor(
  fixtures: ReturnType<typeof readSource>['fixtures'],
  scope: (typeof PUBLIC_SCOPES)[number],
): number {
  let floor = 0;
  for (const { fixture } of fixtures) {
    if (fixture.operationName !== 'SearchClimbs' || !isRecord(fixture.variables)) continue;
    const input = fixture.variables.input;
    if (!isRecord(input)) continue;
    const { page, pageSize, ...filters } = input;
    if (canonicalJson(filters) !== canonicalJson(countInput(scope))) continue;
    if (
      !Number.isSafeInteger(page) ||
      (page as number) < 0 ||
      !Number.isSafeInteger(pageSize) ||
      (pageSize as number) < 1
    )
      throw new Error('Recorded search pagination cannot prove a count floor');
    if (!isRecord(fixture.response) || fixture.response.errors !== undefined || !isRecord(fixture.response.data))
      throw new Error('Recorded search cannot prove a count floor');
    const search = fixture.response.data.searchClimbs;
    if (
      !isRecord(search) ||
      !Array.isArray(search.climbs) ||
      typeof search.hasMore !== 'boolean' ||
      search.climbs.length > (pageSize as number)
    )
      throw new Error('Recorded search rows cannot prove a count floor');
    // An empty out-of-range page does not prove its offset exists in the list.
    if (search.climbs.length === 0) {
      if (search.hasMore) throw new Error('Empty recorded page cannot have more results');
      continue;
    }
    const minimum = (page as number) * (pageSize as number) + search.climbs.length + (search.hasMore ? 1 : 0);
    if (!Number.isSafeInteger(minimum)) throw new Error('Recorded count floor exceeds the integer range');
    floor = Math.max(floor, minimum);
  }
  if (floor < 1) throw new Error('Public scope has no positive recorded count floor');
  return floor;
}

export interface CampaignCountOptions {
  /** Original archive bytes, checked against the committed pin inside this helper. */
  baseArchive: Buffer;
  /** Original same-account Spray CPP archive, likewise checked against its pin. */
  sprayArchive: Buffer;
  outputDirectory: string;
}

/**
 * Refresh only counts from the explicit original snapshot, even after the active
 * listing pin advances. Manufacturer and owner fixture bytes stay unchanged;
 * six public reads and one immutable owner count need no auth or app mutations.
 */
export async function recordIosCampaignCounts(
  options: CampaignCountOptions,
  backendFactory: typeof createScreenshotBackend = createScreenshotBackend,
) {
  if (existsSync(options.outputDirectory)) throw new Error('Candidate output already exists');
  const pinBytes = PIN_FILES.map((filename) => readFileSync(filename));
  const baseReference = readFixtureSnapshotReference(COUNT_BASE_REFERENCE);
  const sprayReference = readFixtureSnapshotReference(SPRAY_REFERENCE);
  const baseFiles = decodeFixtureSnapshot(options.baseArchive, baseReference);
  const sprayFiles = decodeFixtureSnapshot(options.sprayArchive, sprayReference);
  const base = readSource(baseFiles);
  const spray = readSource(sprayFiles);
  if (
    base.manifest.flow !== 'app-store-campaign' ||
    base.manifest.upstream !== UPSTREAM ||
    !base.manifest.accountUserId ||
    !base.manifest.accountEmail ||
    base.manifest.capture?.boards.length !== 7 ||
    !base.manifest.capture.sharedSessionId ||
    base.manifest.capture.cpp ||
    spray.manifest.flow !== 'app-store-cpp' ||
    spray.manifest.capture?.cpp?.target !== 'spray' ||
    spray.manifest.upstream !== UPSTREAM ||
    spray.manifest.accountUserId !== base.manifest.accountUserId ||
    spray.manifest.accountEmail !== base.manifest.accountEmail ||
    base.manifest.graphql.some((entry) => entry.operationName === OPERATION) ||
    process.env.BOARDSESH_SCREENSHOT_CAPTURE_SCENARIO
  )
    throw new Error('Campaign identity, coverage, or existing count recordings differ');

  const seeds = [...PUBLIC_SCOPES, SPRAY_SCOPE].map((scope) => {
    const variables = { input: { ...countInput(scope), page: 0, pageSize: 6 } };
    const matches = base.fixtures.filter(
      ({ fixture }) =>
        fixture.operationName === 'SearchClimbs' && canonicalJson(fixture.variables) === canonicalJson(variables),
    );
    if (matches.length !== 1) throw new Error('Missing exact campaign board seed');
    return matches[0];
  });
  const sprayVariables = { input: { ...countInput(SPRAY_SCOPE), page: 0, pageSize: 1 } };
  const sprayKey = fixtureKey({ operationName: OPERATION, query: SEARCH_CLIMBS_COUNT, variables: sprayVariables });
  const sprayCounts = spray.fixtures.filter(
    ({ entry, fixture }) =>
      entry.operationName === OPERATION &&
      entry.variablesHash === sprayKey.variablesHash &&
      entry.documentHash === sprayKey.documentHash &&
      fixture.upstream === UPSTREAM,
  );
  if (sprayCounts.length !== 1) throw new Error('Missing exact original owner count');
  const ownerCount = sprayCounts[0];
  const publicCountFloors = PUBLIC_SCOPES.map((scope) => recordedCountFloor(base.fixtures, scope));
  const seedResponse = seeds.at(-1)!.fixture.response as {
    data?: { searchClimbs?: { climbs?: unknown[]; hasMore?: boolean } };
  };
  const privateSeed = seedResponse.data?.searchClimbs;
  if (
    privateSeed?.hasMore !== false ||
    !Array.isArray(privateSeed.climbs) ||
    privateSeed.climbs.length === 0 ||
    countResponse(ownerCount.fixture.response) !== privateSeed.climbs.length
  )
    throw new Error('Owner count does not match the recorded complete private Spraywall seed');

  mkdirSync(options.outputDirectory, { recursive: true });
  const recordedDirectory = join(options.outputDirectory, 'recorded-extension');
  const recorder = backendFactory({
    mode: 'record',
    fixturesDir: recordedDirectory,
    upstreamUrl: UPSTREAM,
    frozenNow: startOfSecondIso(new Date()),
    flow: base.manifest.flow,
    fresh: true,
    log: () => {},
  });
  const publicResponses: unknown[] = [];
  try {
    const port = await recorder.listen(0, '127.0.0.1');
    for (const [index, scope] of PUBLIC_SCOPES.entries()) {
      const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: OPERATION,
          query: SEARCH_CLIMBS_COUNT,
          variables: { input: countInput(scope) },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error('Public count request failed');
      const actual: unknown = await response.json();
      if (countResponse(actual) < publicCountFloors[index])
        throw new Error('Public count contradicts recorded search coverage');
      publicResponses.push(actual);
    }
    if (recorder.stats().recorded !== 6 || recorder.stats().redacted !== 0)
      throw new Error('Expected exactly six ordinary public recordings');
  } finally {
    await recorder.close();
  }
  const extension = readScreenshotFixtureManifest(recordedDirectory);
  if (
    !extension ||
    extension.graphql.length !== 6 ||
    extension.static.length ||
    extension.capture ||
    extension.upstream !== UPSTREAM ||
    extension.accountUserId ||
    extension.accountEmail
  )
    throw new Error('Unexpected anonymous recording coverage');
  const additions: Array<{ entry: GraphqlManifestEntry; fixture: GraphqlFixtureFile; bytes: Buffer }> =
    PUBLIC_SCOPES.map((scope, index) => {
      const variables = { input: countInput(scope) };
      const key = fixtureKey({ operationName: OPERATION, query: SEARCH_CLIMBS_COUNT, variables });
      const entries = extension.graphql.filter(
        (entry) => entry.operationName === OPERATION && entry.variablesHash === key.variablesHash,
      );
      if (entries.length !== 1) throw new Error('Missing exact public count recording');
      const entry = entries[0];
      const bytes = readFileSync(join(recordedDirectory, entry.file));
      const fixture = JSON.parse(bytes.toString()) as GraphqlFixtureFile;
      if (
        canonicalJson(fixtureKey(fixture)) !== canonicalJson(key) ||
        entry.documentHash !== key.documentHash ||
        fixture.documentHash !== key.documentHash ||
        fixture.variablesHash !== key.variablesHash ||
        fixture.status !== 200 ||
        fixture.upstream !== UPSTREAM ||
        !Number.isFinite(Date.parse(fixture.recordedAt)) ||
        canonicalJson(fixture.response) !== canonicalJson(publicResponses[index])
      )
        throw new Error('Public recording changed its genuine request or response');
      return { entry, fixture, bytes };
    });
  additions.push(ownerCount);
  const candidateDirectory = join(options.outputDirectory, 'merged');
  mkdirSync(candidateDirectory);
  for (const [file, bytes] of baseFiles) {
    if (file === 'manifest.json') continue;
    mkdirSync(dirname(join(candidateDirectory, file)), { recursive: true });
    writeFileSync(join(candidateDirectory, file), bytes, { flag: 'wx' });
  }
  for (const { entry, bytes } of additions) {
    if (baseFiles.has(entry.file)) throw new Error('Count addition would overwrite an original file');
    mkdirSync(dirname(join(candidateDirectory, entry.file)), { recursive: true });
    writeFileSync(join(candidateDirectory, entry.file), bytes, { flag: 'wx' });
  }
  const candidate = { ...base.manifest, graphql: [...base.manifest.graphql, ...additions.map(({ entry }) => entry)] };
  candidate.graphql = sortManifestEntries(candidate).graphql;
  writeFileSync(join(candidateDirectory, 'manifest.json'), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });

  const replay = backendFactory({
    mode: 'replay',
    fixturesDir: candidateDirectory,
    upstreamUrl: null,
    frozenNow: candidate.frozenNow,
    log: () => {},
  });
  try {
    const port = await replay.listen(0, '127.0.0.1');
    for (const [index, scope] of [...PUBLIC_SCOPES, SPRAY_SCOPE].entries()) {
      const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: OPERATION,
          query: SEARCH_CLIMBS_COUNT,
          variables: { input: countInput(scope) },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const actual: unknown = await response.json();
      const expected = index < 6 ? publicResponses[index] : ownerCount.fixture.response;
      if (!response.ok || canonicalJson(actual) !== canonicalJson(expected))
        throw new Error('Count failed genuine response replay');
      countResponse(actual);
    }
    if (replay.stats().hits !== 7 || replay.stats().misses !== 0) throw new Error('Count replay was incomplete');
  } finally {
    await replay.close();
  }
  if (canonicalJson(readScreenshotFixtureManifest(candidateDirectory)) !== canonicalJson(candidate))
    throw new Error('Candidate changed its manifest or provenance');
  for (const [file, bytes] of baseFiles)
    if (file !== 'manifest.json' && !readFileSync(join(candidateDirectory, file)).equals(bytes))
      throw new Error('Candidate changed an original file');
  for (const { entry, bytes } of additions)
    if (!readFileSync(join(candidateDirectory, entry.file)).equals(bytes))
      throw new Error('Candidate changed a count recording');
  for (const [index, filename] of PIN_FILES.entries())
    if (!readFileSync(filename).equals(pinBytes[index])) throw new Error('Committed fixture pin changed');

  const archive = createFixtureSnapshotArchive(candidateDirectory);
  const archiveName = `ios-campaign-${archive.reference.sha256}.json.gz`;
  const reference = {
    ...archive.reference,
    url: `https://github.com/boardsesh/boardsesh/releases/download/screenshots-baseline/${archiveName}`,
  };
  const proof = {
    baseArchiveSha256: baseReference.sha256,
    sprayArchiveSha256: sprayReference.sha256,
    unchangedGraphqlFiles: base.manifest.graphql.length,
    unchangedStaticFiles: base.manifest.static.length,
    captureMetadataPreserved: true,
    accountMetadataPreserved: true,
    frozenNowPreserved: candidate.frozenNow === base.manifest.frozenNow,
    frozenNow: candidate.frozenNow,
    currentDocumentReplayHits: 7,
    currentDocumentReplayMisses: 0,
    fullNativeReplayRequired: true,
    counts: additions.map(({ entry, fixture, bytes }, index) => ({
      ...entry,
      source: index < 6 ? 'anonymous-production-recording' : 'original-same-account-spray-cpp',
      fixtureSha256: snapshotHash(bytes),
      recordedAt: fixture.recordedAt,
      upstream: fixture.upstream,
      variables: fixture.variables,
      totalCount: countResponse(fixture.response),
      ...(index < 6 ? { recordedCountFloor: publicCountFloors[index] } : {}),
    })),
  };
  const exportDirectory = join(options.outputDirectory, 'export');
  mkdirSync(exportDirectory);
  writeFileSync(join(exportDirectory, archiveName), archive.compressed, { flag: 'wx' });
  writeFileSync(join(exportDirectory, 'campaign.json'), `${JSON.stringify(reference, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(exportDirectory, 'campaign.proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
  return { exportDirectory, reference, proof };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 1)
    throw new Error('Usage: vp exec tsx scripts/record-ios-campaign-counts.ts <new-output-directory>');
  const references = [COUNT_BASE_REFERENCE, SPRAY_REFERENCE].map((filename) => readFixtureSnapshotReference(filename));
  const directories = await Promise.all(references.map((reference) => ensureScreenshotFixtures(reference)));
  const archives = directories.map((directory, index) =>
    readFileSync(join(dirname(directory), `${references[index].sha256}.json.gz`)),
  );
  const result = await recordIosCampaignCounts({
    baseArchive: archives[0],
    sprayArchive: archives[1],
    outputDirectory: resolve(args[0]),
  });
  console.log(JSON.stringify(result.proof));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Campaign count recording failed');
    process.exitCode = 1;
  });
