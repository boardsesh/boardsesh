/// <reference types="node" />

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GET_PRIVACY_SETTINGS } from '../packages/shared/graphql/src/operations/privacy';
import { createScreenshotBackend, readScreenshotFixtureManifest } from './lib/screenshot-backend';
import { createFixtureSnapshotArchive } from './lib/screenshot-fixture-archive';
import {
  ensureScreenshotFixtures,
  FIXTURE_SNAPSHOT_REFERENCE,
  IOS_CAMPAIGN_FIXTURE_REFERENCE,
  readFixtureSnapshotReference,
  snapshotHash,
} from './lib/screenshot-fixture-snapshot';
import { canonicalJson, graphqlFixtureKey, startOfSecondIso, type GraphqlFixtureFile } from './lib/screenshot-fixtures';
import { main as mergeRecordings } from './screenshot-fixtures-merge';

const UPSTREAM = 'https://ws.boardsesh.com';
const OPERATION = 'PrivacySettings';
const REQUEST_TIMEOUT_MS = 30_000;

class PrivacyRefreshError extends Error {}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function assertPrivacyResponse(response: unknown): void {
  if (!isRecord(response) || response.errors !== undefined || !isRecord(response.data))
    throw new Error('Invalid response');
  const settings = response.data.privacySettings;
  if (
    !isRecord(settings) ||
    typeof settings.isPrivate !== 'boolean' ||
    typeof settings.anonymousOnForeignBoards !== 'boolean' ||
    typeof settings.enabled !== 'boolean' ||
    !Number.isSafeInteger(settings.privacyRevision) ||
    typeof settings.defaultSessionAudience !== 'string' ||
    !['public', 'followers', 'only_me', 'unlisted', 'invite_only'].includes(settings.defaultSessionAudience)
  )
    throw new Error('Incomplete current privacy response');
}

export interface PrivacyRefreshOptions {
  /** Already checksum-verified immutable Apple campaign, never modified. */
  baseDirectory: string;
  /** A new directory; existing output is refused. */
  outputDirectory: string;
  email: string;
  password: string;
}

/** One fixed genuine query, recorded normally, merged normally, then replayed normally. */
export async function recordIosCampaignPrivacy(
  options: PrivacyRefreshOptions,
  backendFactory: typeof createScreenshotBackend = createScreenshotBackend,
) {
  let stage = 'Validate the original Apple campaign and screenshot account';
  try {
    const basePath = resolve(options.baseDirectory);
    const outputPath = resolve(options.outputDirectory);
    if (outputPath === basePath || outputPath.startsWith(`${basePath}${sep}`))
      throw new Error('Output must be separate from the original campaign');
    const pinFiles = [IOS_CAMPAIGN_FIXTURE_REFERENCE, FIXTURE_SNAPSHOT_REFERENCE];
    const originalPins = pinFiles.map((filename) => readFileSync(filename));
    const originalManifest = readFileSync(join(options.baseDirectory, 'manifest.json'));
    const base = readScreenshotFixtureManifest(options.baseDirectory);
    if (
      !base ||
      base.flow !== 'app-store-campaign' ||
      base.upstream !== UPSTREAM ||
      !base.accountUserId ||
      !options.email ||
      !options.password ||
      options.email.trim().toLowerCase() !== base.accountEmail.trim().toLowerCase() ||
      !base.capture?.sharedSessionId ||
      base.capture.boards.length !== 7 ||
      base.capture.cpp
    )
      throw new Error('Invalid base or account');
    createFixtureSnapshotArchive(options.baseDirectory);
    const originalFiles = new Map<string, Buffer>([['manifest.json', originalManifest]]);
    for (const entry of base.graphql) {
      const bytes = readFileSync(join(options.baseDirectory, entry.file));
      const fixture = JSON.parse(bytes.toString('utf8')) as GraphqlFixtureFile;
      const key = graphqlFixtureKey(fixture, (text) => snapshotHash(Buffer.from(text)));
      if (
        fixture.operationName !== entry.operationName ||
        fixture.documentHash !== entry.documentHash ||
        fixture.variablesHash !== entry.variablesHash ||
        key.documentHash !== entry.documentHash ||
        key.variablesHash !== entry.variablesHash ||
        fixture.status !== 200
      )
        throw new Error('Original fixture identity is invalid');
      originalFiles.set(entry.file, bytes);
    }
    for (const entry of base.static) {
      const bytes = readFileSync(join(options.baseDirectory, entry.file));
      if (bytes.length !== entry.bytes) throw new Error('Original static fixture is invalid');
      originalFiles.set(entry.file, bytes);
    }
    function assertOriginalsUnchanged(): void {
      for (const [file, bytes] of originalFiles)
        if (!readFileSync(join(options.baseDirectory, file)).equals(bytes))
          throw new Error('Original campaign changed');
      for (const [index, filename] of pinFiles.entries())
        if (!readFileSync(filename).equals(originalPins[index])) throw new Error('Committed fixture pin changed');
    }
    const currentKey = graphqlFixtureKey(
      { operationName: OPERATION, query: GET_PRIVACY_SETTINGS, variables: {} },
      (text) => snapshotHash(Buffer.from(text)),
    );
    const originals = base.graphql.filter((entry) => entry.operationName === OPERATION);
    if (originals.length !== 1 || originals[0].variablesHash !== currentKey.variablesHash)
      throw new Error('Expected one recorded privacy response');
    const original = originals[0];
    const originalBytes = readFileSync(join(options.baseDirectory, original.file));
    const originalFixture = JSON.parse(originalBytes.toString('utf8')) as GraphqlFixtureFile;
    const frozenNow = startOfSecondIso(new Date());
    mkdirSync(options.outputDirectory);
    const extensionDirectory = join(options.outputDirectory, 'recorded-extension');
    const mergedDirectory = join(options.outputDirectory, 'merged');
    const recorder = backendFactory({
      mode: 'record',
      fixturesDir: extensionDirectory,
      upstreamUrl: UPSTREAM,
      frozenNow,
      flow: base.flow,
      fresh: true,
      log: () => {},
    });
    let actualResponse: unknown;
    try {
      const port = await recorder.listen(0, '127.0.0.1');
      const origin = `http://127.0.0.1:${port}`;
      stage = 'Authenticate the original screenshot account through the recorder';
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
        !isRecord(session) ||
        typeof session.jwt !== 'string' ||
        !identity ||
        identity.accountUserId !== base.accountUserId ||
        identity.accountEmail !== base.accountEmail ||
        identity.upstream !== base.upstream ||
        identity.flow !== base.flow
      )
        throw new Error('Authentication did not verify the original account');
      stage = 'Record the genuine current PrivacySettings response';
      const response = await fetch(`${origin}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.jwt}` },
        body: JSON.stringify({ operationName: OPERATION, query: GET_PRIVACY_SETTINGS, variables: {} }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('Upstream failed');
      actualResponse = await response.json();
      assertPrivacyResponse(actualResponse);
      if (recorder.stats().recorded !== 1 || recorder.stats().redacted !== 0)
        throw new Error('Expected exactly one safe recorded response');
    } finally {
      await recorder.close();
    }

    stage = 'Verify the recorded document and merge the genuine newer response';
    const extension = readScreenshotFixtureManifest(extensionDirectory);
    if (
      !extension ||
      extension.graphql.length !== 1 ||
      extension.static.length !== 0 ||
      extension.capture ||
      extension.upstream !== UPSTREAM ||
      extension.accountUserId !== base.accountUserId ||
      extension.accountEmail !== base.accountEmail ||
      extension.flow !== base.flow
    )
      throw new Error('Unexpected recording coverage');
    const fresh = extension.graphql[0];
    const freshBytes = readFileSync(join(extensionDirectory, fresh.file));
    const freshFixture = JSON.parse(freshBytes.toString('utf8')) as GraphqlFixtureFile;
    if (
      fresh.operationName !== OPERATION ||
      fresh.file !== original.file ||
      fresh.documentHash !== currentKey.documentHash ||
      fresh.variablesHash !== currentKey.variablesHash ||
      freshFixture.query !== GET_PRIVACY_SETTINGS ||
      freshFixture.operationName !== OPERATION ||
      freshFixture.documentHash !== currentKey.documentHash ||
      freshFixture.variablesHash !== currentKey.variablesHash ||
      canonicalJson(freshFixture.variables) !== canonicalJson({}) ||
      freshFixture.upstream !== base.upstream ||
      freshFixture.status !== 200 ||
      canonicalJson(freshFixture.response) !== canonicalJson(actualResponse) ||
      !Number.isFinite(Date.parse(freshFixture.recordedAt)) ||
      !Number.isFinite(Date.parse(originalFixture.recordedAt)) ||
      Date.parse(freshFixture.recordedAt) <= Date.parse(originalFixture.recordedAt)
    )
      throw new Error('Recording does not prove a genuine newer response');
    if (
      mergeRecordings([
        '--out',
        mergedDirectory,
        '--on-conflict',
        'newest',
        options.baseDirectory,
        extensionDirectory,
      ]) !== 0
    )
      throw new Error('Merge failed');
    const candidate = readScreenshotFixtureManifest(mergedDirectory);
    if (
      !candidate ||
      canonicalJson(candidate.capture) !== canonicalJson(base.capture) ||
      canonicalJson(candidate.approvedTestUserIds) !== canonicalJson(base.approvedTestUserIds) ||
      candidate.accountEmail !== base.accountEmail ||
      candidate.accountUserId !== base.accountUserId ||
      candidate.upstream !== base.upstream ||
      candidate.flow !== base.flow ||
      candidate.graphql.length !== base.graphql.length ||
      canonicalJson(candidate.static) !== canonicalJson(base.static) ||
      canonicalJson(
        candidate.graphql
          .filter((entry) => entry.operationName !== OPERATION)
          .sort((left, right) => left.file.localeCompare(right.file)),
      ) !==
        canonicalJson(
          base.graphql
            .filter((entry) => entry.operationName !== OPERATION)
            .sort((left, right) => left.file.localeCompare(right.file)),
        ) ||
      Date.parse(candidate.frozenNow) < Date.parse(base.frozenNow) ||
      Date.parse(candidate.frozenNow) < Date.parse(freshFixture.recordedAt) ||
      !readFileSync(join(mergedDirectory, original.file)).equals(freshBytes)
    )
      throw new Error('Candidate changed campaign provenance or failed to replace privacy');
    for (const entry of [...base.graphql, ...base.static]) {
      if (entry.file === original.file) continue;
      if (!originalFiles.get(entry.file)?.equals(readFileSync(join(mergedDirectory, entry.file))))
        throw new Error('Candidate changed an unrelated recording');
    }

    stage = 'Validate current PrivacySettings replay and candidate integrity';
    const replay = backendFactory({
      mode: 'replay',
      upstreamUrl: null,
      fixturesDir: mergedDirectory,
      frozenNow: candidate.frozenNow,
      log: () => {},
    });
    try {
      const port = await replay.listen(0, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationName: OPERATION, query: GET_PRIVACY_SETTINGS, variables: {} }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const replayed: unknown = await response.json();
      assertPrivacyResponse(replayed);
      if (
        !response.ok ||
        canonicalJson(replayed) !== canonicalJson(actualResponse) ||
        replay.stats().hits !== 1 ||
        replay.stats().misses !== 0
      )
        throw new Error('Current document did not replay its actual recorded response');
    } finally {
      await replay.close();
    }
    const archive = createFixtureSnapshotArchive(mergedDirectory);
    assertOriginalsUnchanged();
    const proof = {
      operationName: OPERATION,
      baseManifestSha256: snapshotHash(readFileSync(join(options.baseDirectory, 'manifest.json'))),
      previousDocumentHash: original.documentHash,
      currentDocumentHash: fresh.documentHash,
      replacedFile: original.file,
      previousFixtureSha256: snapshotHash(originalBytes),
      recordedFixtureSha256: snapshotHash(freshBytes),
      unchangedGraphqlFiles: base.graphql.length - 1,
      unchangedStaticFiles: base.static.length,
      captureMetadataPreserved: true,
      approvedAccountIdsPreserved: true,
      originalBaseFilesPreserved: originalFiles.size,
      unchangedCommittedPins: pinFiles.length,
      applePinSha256: snapshotHash(originalPins[0]),
      sharedPinSha256: snapshotHash(originalPins[1]),
      originalFrozenNowSha256: snapshotHash(Buffer.from(base.frozenNow)),
      candidateFrozenNowSha256: snapshotHash(Buffer.from(candidate.frozenNow)),
      currentDocumentReplayHits: 1,
      currentDocumentReplayMisses: 0,
      fullNativeReplayRequired: true,
    };
    const exportDirectory = join(options.outputDirectory, 'export');
    mkdirSync(exportDirectory);
    writeFileSync(join(exportDirectory, 'campaign.json.gz'), archive.compressed, { flag: 'wx' });
    writeFileSync(join(exportDirectory, 'campaign.digest.json'), `${JSON.stringify(archive.reference, null, 2)}\n`, {
      flag: 'wx',
    });
    writeFileSync(join(exportDirectory, 'campaign.proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
    assertOriginalsUnchanged();
    return { exportDirectory, proof, digest: archive.reference };
  } catch {
    // Neither network exceptions nor server response bodies may expose credentials.
    throw new PrivacyRefreshError(`${stage} failed; no candidate was approved.`);
  }
}

export async function main(): Promise<void> {
  if (process.argv.slice(2).length || !process.env.RUNNER_TEMP)
    throw new PrivacyRefreshError('This fixed CI helper accepts no arguments and requires RUNNER_TEMP.');
  if (process.env.GITHUB_REF !== 'refs/heads/main')
    throw new PrivacyRefreshError('This fixed CI helper requires the protected main workflow.');
  let baseDirectory: string;
  try {
    baseDirectory = await ensureScreenshotFixtures(readFixtureSnapshotReference(IOS_CAMPAIGN_FIXTURE_REFERENCE));
  } catch {
    throw new PrivacyRefreshError('Could not verify the committed Apple campaign archive.');
  }
  const result = await recordIosCampaignPrivacy({
    baseDirectory,
    outputDirectory: join(resolve(process.env.RUNNER_TEMP), 'ios-campaign-privacy-candidate'),
    email: process.env.SCREENSHOT_USER_EMAIL ?? '',
    password: process.env.SCREENSHOT_USER_PASSWORD ?? '',
  });
  console.log(JSON.stringify(result.proof));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error: unknown) => {
    console.error(
      error instanceof PrivacyRefreshError
        ? error.message
        : 'Privacy fixture refresh failed; no candidate was approved.',
    );
    process.exitCode = 1;
  });
