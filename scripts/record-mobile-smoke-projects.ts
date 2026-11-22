/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Kind, parse, type SelectionSetNode } from 'graphql';
import { GET_USER_ASCENTS_FEED } from '../packages/shared/graphql/src/operations/ticks';
import { createScreenshotBackend, readScreenshotFixtureManifest } from './lib/screenshot-backend';
import { applyFixtureOverlay } from './lib/screenshot-fixture-overlay';
import {
  decodeFixtureSnapshot,
  ensureScreenshotFixtures,
  FIXTURE_SNAPSHOT_REFERENCE,
  readFixtureSnapshotReference,
  snapshotHash,
  type FixtureSnapshotReference,
} from './lib/screenshot-fixture-snapshot';
import {
  canonicalJson,
  finalizeRecordingFrozenNow,
  findSensitiveVariableKeys,
  graphqlFixtureKey,
  pseudonymiseResponse,
  sortManifestEntries,
  startOfSecondIso,
  validateScreenshotFixtureManifest,
  type GraphqlFixtureFile,
} from './lib/screenshot-fixtures';

const UPSTREAM = 'https://ws.boardsesh.com';
const OPERATION = 'GetUserAscentsFeed';
const REQUEST_TIMEOUT_MS = 30_000;
const INPUT = { statusMode: 'attempt', limit: 50, offset: 0 } as const;
class SmokeProjectsRecordingError extends Error {}

function object(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}

/** Require every selected field, and reject undeclared fields that could carry credentials. */
function assertSelection(selection: SelectionSetNode, response: unknown): void {
  if (!object(response)) throw new Error('Expected a response object');
  const fields = selection.selections.map((node) => {
    if (node.kind !== Kind.FIELD) throw new Error('Unexpected document fragment');
    return node;
  });
  const keys = fields.map((field) => field.alias?.value ?? field.name.value);
  if (canonicalJson(Object.keys(response).sort()) !== canonicalJson(keys.sort()))
    throw new Error('Incomplete or unexpected response fields');
  for (const field of fields) {
    const selected = response[field.alias?.value ?? field.name.value];
    if (selected === null || !field.selectionSet) continue;
    for (const item of Array.isArray(selected) ? selected : [selected]) assertSelection(field.selectionSet, item);
  }
}

function assertAttemptsResponse(response: unknown): void {
  const definition = parse(GET_USER_ASCENTS_FEED).definitions[0];
  if (definition?.kind !== Kind.OPERATION_DEFINITION || !object(response) || Object.keys(response).join() !== 'data')
    throw new Error('Expected one successful query response');
  assertSelection(definition.selectionSet, response.data);
  if (!object(response.data) || !object(response.data.userAscentsFeed)) throw new Error('Missing attempts page');
  const feed = response.data.userAscentsFeed;
  if (
    !Array.isArray(feed.items) ||
    feed.items.length > INPUT.limit ||
    !Number.isSafeInteger(feed.totalCount) ||
    (feed.totalCount as number) < feed.items.length ||
    typeof feed.hasMore !== 'boolean' ||
    feed.items.some((item) => !object(item) || item.status !== 'attempt') ||
    findSensitiveVariableKeys(response).length
  )
    throw new Error('Invalid attempts page');
}

export interface SmokeProjectsRecordingOptions {
  reference: FixtureSnapshotReference;
  baseArchive: Buffer;
  overlayBytes?: Buffer;
  outputDirectory: string;
  email: string;
  password: string;
}

/** Authenticate the pinned account, record one read, and export an append-only candidate. */
export async function recordMobileSmokeProjects(
  options: SmokeProjectsRecordingOptions,
  backendFactory: typeof createScreenshotBackend = createScreenshotBackend,
) {
  let stage = 'Verify the pinned shared fixture and screenshot account';
  try {
    const baseline = decodeFixtureSnapshot(options.baseArchive, options.reference);
    const baseFiles = options.reference.overlay
      ? applyFixtureOverlay(baseline, options.reference.sha256, options.overlayBytes!, options.reference.overlay)
      : baseline;
    const validation = validateScreenshotFixtureManifest(JSON.parse(baseFiles.get('manifest.json')!.toString()));
    if (!validation.ok) throw new Error('Invalid original manifest');
    const base = validation.manifest;
    if (
      base.upstream !== UPSTREAM ||
      !base.accountUserId ||
      !base.accountEmail ||
      !options.password ||
      options.email.trim().toLowerCase() !== base.accountEmail.trim().toLowerCase() ||
      baseFiles.size !== base.graphql.length + base.static.length + 1
    )
      throw new Error('Wrong recording account or baseline');
    const variables = { userId: base.accountUserId, input: INPUT };
    const key = graphqlFixtureKey({ operationName: OPERATION, query: GET_USER_ASCENTS_FEED, variables }, (text) =>
      snapshotHash(Buffer.from(text)),
    );
    // A different document for the same variables is also a collision; never replace it.
    if (base.graphql.some((entry) => entry.operationName === OPERATION && entry.variablesHash === key.variablesHash))
      throw new Error('The exact request already has a recording');
    for (const entry of base.graphql) {
      const fixture = JSON.parse(baseFiles.get(entry.file)!.toString()) as GraphqlFixtureFile;
      const actualKey = graphqlFixtureKey(fixture, (text) => snapshotHash(Buffer.from(text)));
      if (
        actualKey.documentHash !== entry.documentHash ||
        actualKey.variablesHash !== entry.variablesHash ||
        fixture.documentHash !== entry.documentHash ||
        fixture.variablesHash !== entry.variablesHash ||
        fixture.operationName !== entry.operationName
      )
        throw new Error('Original recording identity differs');
    }
    for (const entry of base.static)
      if (baseFiles.get(entry.file)?.length !== entry.bytes) throw new Error('Original image bytes differ');

    mkdirSync(options.outputDirectory);
    const extensionDirectory = join(options.outputDirectory, 'recorded-extension');
    const recorder = backendFactory({
      mode: 'record',
      fixturesDir: extensionDirectory,
      upstreamUrl: UPSTREAM,
      frozenNow: startOfSecondIso(new Date()),
      flow: base.flow,
      fresh: true,
      log: () => {},
    });
    let actualResponse: unknown;
    try {
      const port = await recorder.listen(0, '127.0.0.1');
      const origin = `http://127.0.0.1:${port}`;
      stage = 'Authenticate the original screenshot account';
      const auth = await fetch(`${origin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: options.email, password: options.password }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const session: unknown = await auth.json();
      const identity = readScreenshotFixtureManifest(extensionDirectory);
      if (
        !auth.ok ||
        !object(session) ||
        typeof session.jwt !== 'string' ||
        identity?.accountUserId !== base.accountUserId ||
        identity.accountEmail !== base.accountEmail ||
        identity.upstream !== base.upstream ||
        identity.flow !== base.flow
      )
        throw new Error('Authentication did not prove the pinned account');
      stage = 'Record the genuine Home projects attempts page';
      const response = await fetch(`${origin}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.jwt}` },
        body: JSON.stringify({ operationName: OPERATION, query: GET_USER_ASCENTS_FEED, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      actualResponse = await response.json();
      assertAttemptsResponse(actualResponse);
      if (!response.ok || recorder.stats().recorded !== 1 || recorder.stats().redacted !== 0)
        throw new Error('Expected one safe successful recording');
    } finally {
      await recorder.close();
    }

    stage = 'Verify the genuine recording and append-only overlay';
    const extension = readScreenshotFixtureManifest(extensionDirectory);
    if (!extension || extension.graphql.length !== 1 || extension.static.length !== 0)
      throw new Error('Unexpected recorded requests');
    const entry = extension.graphql[0]!;
    const bytes = readFileSync(join(extensionDirectory, entry.file));
    const fixture = JSON.parse(bytes.toString()) as GraphqlFixtureFile;
    const sanitized = pseudonymiseResponse(actualResponse, { ownUserId: base.accountUserId }).response;
    if (
      entry.operationName !== OPERATION ||
      entry.documentHash !== key.documentHash ||
      entry.variablesHash !== key.variablesHash ||
      entry.file !== `graphql/${OPERATION}/${key.variablesHash.slice(0, 16)}.json` ||
      fixture.formatVersion !== 1 ||
      fixture.operationName !== OPERATION ||
      fixture.documentHash !== key.documentHash ||
      fixture.variablesHash !== key.variablesHash ||
      fixture.upstream !== UPSTREAM ||
      fixture.query !== GET_USER_ASCENTS_FEED ||
      fixture.status !== 200 ||
      canonicalJson(fixture.variables) !== canonicalJson(variables) ||
      canonicalJson(fixture.response) !== canonicalJson(sanitized) ||
      !Number.isFinite(Date.parse(fixture.recordedAt)) ||
      baseFiles.has(entry.file)
    )
      throw new Error('Recorded request differs or collides');
    assertAttemptsResponse(fixture.response);
    const candidate = sortManifestEntries({
      ...base,
      recordedAt: fixture.recordedAt,
      frozenNow: finalizeRecordingFrozenNow(base.frozenNow, [fixture.recordedAt]),
      graphql: [...base.graphql, entry],
    });
    const candidateFiles = new Map(baseFiles);
    candidateFiles.set(entry.file, bytes);
    candidateFiles.set('manifest.json', Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`));
    const overlayFiles = Object.fromEntries(
      [...candidateFiles]
        .filter(([path]) => path === 'manifest.json' || !baseline.has(path))
        .map(([path, contents]) => [path, contents.toString('base64')]),
    );
    const compressed = gzipSync(
      JSON.stringify({ version: 1, baseSha256: options.reference.sha256, files: overlayFiles }),
      { level: 9 },
    );
    const sha256 = snapshotHash(compressed);
    const overlay = {
      path: `app-stores/screenshot-fixture-overlays/${sha256}.json.gz`,
      sha256,
      bytes: compressed.length,
      files: candidateFiles.size,
    };
    const applied = applyFixtureOverlay(baseline, options.reference.sha256, compressed, overlay);
    if ([...candidateFiles].some(([path, contents]) => !applied.get(path)?.equals(contents)))
      throw new Error('Overlay changed recorded bytes');
    const candidateDirectory = join(options.outputDirectory, 'candidate');
    for (const [path, contents] of candidateFiles) {
      mkdirSync(dirname(join(candidateDirectory, path)), { recursive: true });
      writeFileSync(join(candidateDirectory, path), contents, { flag: 'wx' });
    }
    stage = 'Replay the current Home projects request';
    const replay = backendFactory({
      mode: 'replay',
      upstreamUrl: null,
      fixturesDir: candidateDirectory,
      frozenNow: candidate.frozenNow,
      log: () => {},
    });
    try {
      const port = await replay.listen(0, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationName: OPERATION, query: GET_USER_ASCENTS_FEED, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (
        !response.ok ||
        canonicalJson(await response.json()) !== canonicalJson(fixture.response) ||
        replay.stats().hits !== 1 ||
        replay.stats().misses !== 0
      )
        throw new Error('Current query did not replay exactly');
    } finally {
      await replay.close();
    }
    const proof = {
      operationName: OPERATION,
      baseArchiveSha256: options.reference.sha256,
      previousOverlaySha256: options.reference.overlay?.sha256 ?? null,
      baseManifestSha256: snapshotHash(baseFiles.get('manifest.json')!),
      recordedFixtureSha256: snapshotHash(bytes),
      documentHash: key.documentHash,
      variablesHash: key.variablesHash,
      unchangedRecordedFiles: baseFiles.size - 1,
      addedGraphqlFiles: 1,
      replayHits: 1,
      replayMisses: 0,
      fullNativeReplayRequired: true,
    };
    const exportDirectory = join(options.outputDirectory, 'export');
    mkdirSync(exportDirectory);
    writeFileSync(join(exportDirectory, `${sha256}.json.gz`), compressed, { flag: 'wx' });
    writeFileSync(
      join(exportDirectory, 'shared.reference.json'),
      `${JSON.stringify({ ...options.reference, overlay }, null, 2)}\n`,
      { flag: 'wx' },
    );
    writeFileSync(join(exportDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
    return { exportDirectory, proof, overlay };
  } catch {
    // Never print network errors, authentication payloads, or response bodies.
    throw new SmokeProjectsRecordingError(`${stage} failed; no candidate was approved.`);
  }
}

export async function main(): Promise<void> {
  if (
    process.argv.slice(2).length ||
    !process.env.RUNNER_TEMP ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_REF_PROTECTED !== 'true' ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== process.env.GITHUB_SHA
  )
    throw new SmokeProjectsRecordingError('This fixed helper requires its protected main dispatch checkout.');
  const pinBytes = readFileSync(FIXTURE_SNAPSHOT_REFERENCE);
  const reference = readFixtureSnapshotReference();
  const baseDirectory = await ensureScreenshotFixtures(reference);
  const result = await recordMobileSmokeProjects({
    reference,
    baseArchive: readFileSync(join(dirname(baseDirectory), `${reference.sha256}.json.gz`)),
    overlayBytes: reference.overlay ? readFileSync(resolve(reference.overlay.path)) : undefined,
    outputDirectory: join(resolve(process.env.RUNNER_TEMP), 'mobile-smoke-projects-candidate'),
    email: process.env.SCREENSHOT_USER_EMAIL ?? '',
    password: process.env.SCREENSHOT_USER_PASSWORD ?? '',
  });
  if (!readFileSync(FIXTURE_SNAPSHOT_REFERENCE).equals(pinBytes))
    throw new SmokeProjectsRecordingError('Shared fixture pin changed during recording; do not install the candidate.');
  console.log(JSON.stringify(result.proof));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error: unknown) => {
    console.error(error instanceof SmokeProjectsRecordingError ? error.message : 'Smoke projects recording failed.');
    process.exitCode = 1;
  });
