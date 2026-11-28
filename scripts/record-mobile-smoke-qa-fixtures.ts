/// <reference types="node" />

/** Fixed read-only recording for the two missing native smoke request keys. */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScreenshotBackend, readScreenshotFixtureManifest } from './lib/screenshot-backend';
import { applyFixtureOverlay } from './lib/screenshot-fixture-overlay';
import {
  decodeFixtureSnapshot,
  ensureScreenshotFixtures,
  readFixtureSnapshotReference,
  type FixtureSnapshotReference,
} from './lib/screenshot-fixture-snapshot';
import { canonicalJson, startOfSecondIso, validateScreenshotFixtureManifest } from './lib/screenshot-fixtures';
import { importMobileSmokeQaFixtures, requiredSmokeQaRequests } from './import-mobile-smoke-qa-fixtures';

const UPSTREAM = 'https://ws.boardsesh.com';
const TIMEOUT_MS = 30_000;
class SmokeQaRecordingError extends Error {}
function object(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}
export interface RecordSmokeQaOptions {
  reference: FixtureSnapshotReference;
  baseArchive: Buffer;
  overlayBytes?: Buffer;
  outputDirectory: string;
  email: string;
  password: string;
}

/** Authenticate exactly the pinned test account, then record two fixed queries through the existing recorder. */
export async function recordMobileSmokeQaFixtures(
  options: RecordSmokeQaOptions,
  backendFactory = createScreenshotBackend,
) {
  let stage = 'Verify the pinned screenshot account';
  try {
    const baseline = decodeFixtureSnapshot(options.baseArchive, options.reference);
    const previous = options.reference.overlay
      ? applyFixtureOverlay(baseline, options.reference.sha256, options.overlayBytes!, options.reference.overlay)
      : baseline;
    const validated = validateScreenshotFixtureManifest(JSON.parse(previous.get('manifest.json')!.toString()));
    if (!validated.ok) throw new Error('Invalid original manifest');
    const base = validated.manifest;
    if (
      base.upstream !== UPSTREAM ||
      base.accountEmail !== 'test@boardsesh.com' ||
      !base.accountUserId ||
      options.email !== base.accountEmail ||
      !options.password
    )
      throw new Error('Wrong recording account or baseline');
    mkdirSync(options.outputDirectory);
    const recorder = backendFactory({
      mode: 'record',
      fixturesDir: options.outputDirectory,
      upstreamUrl: UPSTREAM,
      frozenNow: startOfSecondIso(new Date()),
      flow: 'smoke-fixtures',
      fresh: true,
      log: () => {},
    });
    try {
      const port = await recorder.listen(0, '127.0.0.1');
      const origin = `http://127.0.0.1:${port}`;
      stage = 'Authenticate the pinned screenshot account';
      const auth = await fetch(`${origin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: options.email, password: options.password }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const session: unknown = await auth.json();
      const identity = readScreenshotFixtureManifest(options.outputDirectory);
      if (
        !auth.ok ||
        !object(session) ||
        typeof session.jwt !== 'string' ||
        identity?.accountEmail !== base.accountEmail ||
        identity.accountUserId !== base.accountUserId ||
        identity.upstream !== UPSTREAM ||
        identity.flow !== 'smoke-fixtures'
      )
        throw new Error('Authentication did not prove the pinned account');
      stage = 'Record the exact native smoke requests';
      for (const { operationName, query, variables, response: expectedResponse } of requiredSmokeQaRequests(
        base.accountUserId,
      )) {
        const response = await fetch(`${origin}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session.jwt}` },
          body: JSON.stringify({ operationName, query, variables }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const actualResponse: unknown = await response.json();
        if (!response.ok || canonicalJson(actualResponse) !== canonicalJson(expectedResponse))
          throw new Error('Recording query failed');
      }
      if (recorder.stats().recorded !== 2 || recorder.stats().redacted !== 0)
        throw new Error('Expected exactly two safe recordings');
    } finally {
      await recorder.close();
    }
    stage = 'Verify genuine source bytes and additive import';
    const recordedFiles = new Map<string, Buffer>();
    for (const entry of readdirSync(options.outputDirectory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = join(entry.parentPath, entry.name);
      recordedFiles.set(absolute.slice(options.outputDirectory.length + 1), readFileSync(absolute));
    }
    const source = readScreenshotFixtureManifest(options.outputDirectory);
    if (!source || source.graphql.length !== 2 || source.static.length !== 0 || recordedFiles.size !== 3)
      throw new Error('Unexpected recorded files');
    return importMobileSmokeQaFixtures({ ...options, recordedFiles }).proof;
  } catch {
    throw new SmokeQaRecordingError(`${stage} failed; no recording was approved.`);
  }
}
export async function main() {
  if (process.argv.slice(2).length || !process.env.SMOKE_QA_RECORDING_DIRECTORY)
    throw new SmokeQaRecordingError('The fixed recording workflow must provide its output directory.');
  const reference = readFixtureSnapshotReference();
  const baseDirectory = await ensureScreenshotFixtures(reference);
  const proof = await recordMobileSmokeQaFixtures({
    reference,
    baseArchive: readFileSync(join(dirname(baseDirectory), `${reference.sha256}.json.gz`)),
    overlayBytes: reference.overlay ? readFileSync(resolve(reference.overlay.path)) : undefined,
    outputDirectory: resolve(process.env.SMOKE_QA_RECORDING_DIRECTORY),
    email: process.env.SCREENSHOT_USER_EMAIL ?? '',
    password: process.env.SCREENSHOT_USER_PASSWORD ?? '',
  });
  console.log(JSON.stringify({ ...proof, nativeSmokePassed: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    console.error(
      error instanceof SmokeQaRecordingError
        ? error.message
        : 'Fixed smoke recording failed; secret-bearing details withheld.',
    );
    process.exitCode = 1;
  });
