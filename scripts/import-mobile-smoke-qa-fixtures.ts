/// <reference types="node" />

/** Import only the two newly exercised reads from a genuine Android smoke recording. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BOARD_LAYERS } from '../packages/shared/graphql/src/operations/board-presence';
import { GET_USER_TICKS } from '../packages/shared/graphql/src/operations/ticks';
import { applyFixtureOverlay } from './lib/screenshot-fixture-overlay';
import {
  decodeFixtureSnapshot,
  ensureScreenshotFixtures,
  readFixtureSnapshotReference,
  snapshotHash,
  type FixtureSnapshotReference,
} from './lib/screenshot-fixture-snapshot';
import {
  canonicalJson,
  finalizeRecordingFrozenNow,
  graphqlFixtureKey,
  sortManifestEntries,
  validateScreenshotFixtureManifest,
  type GraphqlFixtureFile,
  type GraphqlManifestEntry,
} from './lib/screenshot-fixtures';

const BOARD_UUID = 'dcb443be-aaea-4637-8bf8-b20cbe031192';
const UPSTREAM = 'https://ws.boardsesh.com';
const REPOSITORY = 'boardsesh/boardsesh';

function readManifest(files: ReadonlyMap<string, Buffer>) {
  const validated = validateScreenshotFixtureManifest(JSON.parse(files.get('manifest.json')!.toString()));
  if (!validated.ok) throw new Error('Invalid recording manifest');
  return validated.manifest;
}
function readFixture(files: ReadonlyMap<string, Buffer>, entry: GraphqlManifestEntry): GraphqlFixtureFile {
  const fixture = JSON.parse(files.get(entry.file)!.toString()) as GraphqlFixtureFile;
  const key = graphqlFixtureKey(fixture, (text) => snapshotHash(Buffer.from(text)));
  if (
    fixture.formatVersion !== 1 ||
    fixture.status !== 200 ||
    fixture.operationName !== entry.operationName ||
    fixture.upstream !== UPSTREAM ||
    key.documentHash !== entry.documentHash ||
    key.variablesHash !== entry.variablesHash ||
    fixture.documentHash !== entry.documentHash ||
    fixture.variablesHash !== entry.variablesHash ||
    entry.file !== `graphql/${entry.operationName}/${key.variablesHash.slice(0, 16)}.json` ||
    !Number.isFinite(Date.parse(fixture.recordedAt))
  )
    throw new Error('Recorded fixture identity or hashes differ');
  return fixture;
}

export function requiredSmokeQaRequests(userId: string) {
  return [
    {
      operationName: 'BoardLayers',
      query: BOARD_LAYERS,
      variables: { boardId: 4, boardUuid: BOARD_UUID },
      response: { data: { boardLayers: null } },
    },
    {
      operationName: 'GetUserTicks',
      query: GET_USER_TICKS,
      variables: { userId: userId, boardType: 'quantum' },
      response: { data: { userTicks: [] } },
    },
  ];
}

export interface ImportSmokeQaOptions {
  reference: FixtureSnapshotReference;
  baseArchive: Buffer;
  overlayBytes?: Buffer;
  recordedFiles: ReadonlyMap<string, Buffer>;
}

/** Preserve every existing recording verbatim, adding only the exact two missing request keys. */
export function importMobileSmokeQaFixtures(options: ImportSmokeQaOptions) {
  const baseline = decodeFixtureSnapshot(options.baseArchive, options.reference);
  const previous = options.reference.overlay
    ? applyFixtureOverlay(baseline, options.reference.sha256, options.overlayBytes!, options.reference.overlay)
    : baseline;
  const base = readManifest(previous);
  const source = readManifest(options.recordedFiles);
  if (
    base.upstream !== UPSTREAM ||
    source.upstream !== UPSTREAM ||
    (source.flow !== 'smoke' && source.flow !== 'smoke-fixtures') ||
    base.accountEmail !== 'test@boardsesh.com' ||
    source.accountEmail !== base.accountEmail ||
    !base.accountUserId ||
    source.accountUserId !== base.accountUserId
  )
    throw new Error('Smoke recording account, upstream or flow differs');

  // The existing snapshot proves this is the default Kilter wall, not a new Quantum identity.
  const resolveEntry = base.graphql.find((entry) => entry.operationName === 'ResolveBoardForUuid');
  if (!resolveEntry) throw new Error('Missing original smoke wall identity');
  const resolved = readFixture(previous, resolveEntry);
  if (
    canonicalJson(resolved.variables) !== canonicalJson({ boardUuid: BOARD_UUID }) ||
    !resolved.response ||
    typeof resolved.response !== 'object' ||
    !('data' in resolved.response)
  )
    throw new Error('Original smoke wall differs');
  const resolvedBoard = (resolved.response as { data: { resolveBoardForUuid: { boardId: number; boardType: string } } })
    .data.resolveBoardForUuid;
  if (resolvedBoard?.boardId !== 4 || resolvedBoard.boardType !== 'kilter')
    throw new Error('Original smoke wall differs');

  const requests = requiredSmokeQaRequests(base.accountUserId);
  const additions = requests.map((request) => {
    const key = graphqlFixtureKey(request, (text) => snapshotHash(Buffer.from(text)));
    if (
      base.graphql.some(
        (entry) => entry.operationName === request.operationName && entry.variablesHash === key.variablesHash,
      )
    )
      throw new Error('Target request already recorded; never replace an existing fixture');
    const matches = source.graphql.filter(
      (entry) => entry.operationName === request.operationName && entry.variablesHash === key.variablesHash,
    );
    if (matches.length !== 1) throw new Error(`Missing exact ${request.operationName} recording`);
    const entry = matches[0]!;
    const fixture = readFixture(options.recordedFiles, entry);
    if (
      fixture.query !== request.query ||
      canonicalJson(fixture.variables) !== canonicalJson(request.variables) ||
      canonicalJson(fixture.response) !== canonicalJson(request.response) ||
      previous.has(entry.file)
    )
      throw new Error(`Unexpected ${request.operationName} response or request`);
    return { entry, fixture, bytes: options.recordedFiles.get(entry.file)! };
  });
  const latestRecordedAt = additions
    .map(({ fixture }) => fixture.recordedAt)
    .reduce((latest, instant) => (Date.parse(instant) > Date.parse(latest) ? instant : latest), base.recordedAt);
  const manifest = sortManifestEntries({
    ...base,
    recordedAt: latestRecordedAt,
    frozenNow: finalizeRecordingFrozenNow(
      base.frozenNow,
      additions.map(({ fixture }) => fixture.recordedAt),
    ),
    graphql: [...base.graphql, ...additions.map(({ entry }) => entry)],
  });
  const candidate = new Map(previous);
  for (const { entry, bytes } of additions) candidate.set(entry.file, bytes);
  candidate.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const compressed = gzipSync(
    JSON.stringify({
      version: 1,
      baseSha256: options.reference.sha256,
      files: Object.fromEntries(
        [...candidate]
          .filter(([path]) => path === 'manifest.json' || !baseline.has(path))
          .map(([path, bytes]) => [path, bytes.toString('base64')]),
      ),
    }),
    { level: 9 },
  );
  const sha256 = snapshotHash(compressed);
  const overlay = {
    path: `app-stores/screenshot-fixture-overlays/${sha256}.json.gz`,
    sha256,
    bytes: compressed.length,
    files: candidate.size,
  };
  const applied = applyFixtureOverlay(baseline, options.reference.sha256, compressed, overlay);
  for (const [path, bytes] of previous)
    if (path !== 'manifest.json' && !applied.get(path)?.equals(bytes))
      throw new Error('Existing recording bytes changed');
  return {
    compressed,
    reference: { ...options.reference, overlay },
    proof: {
      baseArchiveSha256: options.reference.sha256,
      previousOverlaySha256: options.reference.overlay?.sha256 ?? null,
      sourceManifestSha256: snapshotHash(options.recordedFiles.get('manifest.json')!),
      sourceFlow: source.flow,
      unchangedRecordedFiles: previous.size - 1,
      addedGraphqlFiles: additions.map(({ entry, bytes }) => ({ ...entry, sha256: snapshotHash(bytes) })),
      fullNativeReplayRequired: true,
    },
  };
}

type RecordingRun = {
  status: string;
  conclusion: string;
  headSha: string;
  event: string;
  workflowName: string;
  url: string;
  attempt: number;
  jobs: Array<{ conclusion: string; steps: Array<{ name: string; conclusion: string }> }>;
};
function recordingRun(runId: string): RecordingRun {
  const run = JSON.parse(
    execFileSync(
      'gh',
      [
        'run',
        'view',
        runId,
        '--repo',
        REPOSITORY,
        '--json',
        'status,conclusion,headSha,event,workflowName,url,attempt,jobs',
      ],
      { encoding: 'utf8' },
    ),
  ) as RecordingRun;
  if (
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.workflowName !== 'Mobile Screenshots (Android)' ||
    !/^[a-f0-9]{40}$/.test(run.headSha) ||
    run.url !== `https://github.com/${REPOSITORY}/actions/runs/${runId}` ||
    !run.jobs.some(
      (job) =>
        job.conclusion === 'success' &&
        job.steps.some(
          (step) =>
            (step.name === 'Capture Android screenshots' || step.name === 'Record exact mobile smoke requests') &&
            step.conclusion === 'success',
        ),
    )
  )
    throw new Error('A successful dispatched Android smoke recording is required');
  execFileSync('git', ['merge-base', '--is-ancestor', run.headSha, 'HEAD']);
  return run;
}

export async function main(args = process.argv.slice(2)) {
  const [runId, outputDirectory] = args;
  if (args.length !== 2 || !runId || !/^[1-9][0-9]*$/.test(runId) || !outputDirectory)
    throw new Error('Usage: import-mobile-smoke-qa-fixtures.ts <successful-recording-run-id> <output-directory>');
  const before = recordingRun(runId);
  const recordedDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-smoke-recording-'));
  execFileSync('gh', [
    'run',
    'download',
    runId,
    '--repo',
    REPOSITORY,
    '-n',
    'screenshot-fixtures-android',
    '-D',
    recordedDirectory,
  ]);
  const recordedFiles = new Map<string, Buffer>();
  for (const entry of readdirSync(recordedDirectory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    recordedFiles.set(absolute.slice(recordedDirectory.length + 1), readFileSync(absolute));
  }
  const reference = readFixtureSnapshotReference();
  const baseDirectory = await ensureScreenshotFixtures(reference);
  const result = importMobileSmokeQaFixtures({
    reference,
    baseArchive: readFileSync(join(dirname(baseDirectory), `${reference.sha256}.json.gz`)),
    overlayBytes: reference.overlay ? readFileSync(resolve(reference.overlay.path)) : undefined,
    recordedFiles,
  });
  if (canonicalJson(recordingRun(runId)) !== canonicalJson(before))
    throw new Error('Recording run changed during import');
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, `${result.reference.overlay.sha256}.json.gz`), result.compressed, { flag: 'wx' });
  writeFileSync(join(outputDirectory, 'shared.reference.json'), `${JSON.stringify(result.reference, null, 2)}\n`, {
    flag: 'wx',
  });
  writeFileSync(
    join(outputDirectory, 'proof.json'),
    `${JSON.stringify({ sourceRunUrl: before.url, sourceSha: before.headSha, ...result.proof }, null, 2)}\n`,
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ sourceRunUrl: before.url, ...result.proof }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error('Native smoke fixture import failed; no candidate was approved.');
    process.exitCode = 1;
  });
