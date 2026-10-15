/// <reference types="node" />

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseGoogleProductionReleasesResponse } from './mobile-auto-version-bump';
import { createAuditAccessToken, parseExpectedVersionCode } from './mobile-store-android-audit';

const APPLICATION_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.boardsesh.app';
const PUBLISHED = 'RELEASE_LIFECYCLE_STATE_PUBLISHED';
type Track = 'internal' | 'beta';
type JsonRecord = Record<string, unknown>;

function record(input: unknown): JsonRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Google Play returned an invalid object');
  }
  return input as JsonRecord;
}

function summaries(input: unknown, track: Track) {
  const response = record(input);
  // Empty protobuf repeated fields are omitted by Google.
  const releases = response['releases'] ?? [];
  if (!Array.isArray(releases)) throw new Error('Google Play returned invalid releases');
  for (const release of releases) {
    const releaseTrack = record(release)['track'];
    if (releaseTrack !== undefined && releaseTrack !== track) throw new Error('Google Play returned the wrong track');
  }
  return parseGoogleProductionReleasesResponse({ releases });
}

function checkSummaries(internal: unknown, beta: unknown, versionCode: number) {
  const source = summaries(internal, 'internal').filter((release) =>
    release.activeArtifacts.some((artifact) => artifact.versionCode === versionCode),
  );
  if (source.length !== 1 || source[0]!.releaseLifecycleState !== PUBLISHED) {
    throw new Error('Expected exactly one PUBLISHED internal release for ANDROID_VERSION_CODE');
  }
  const betaReleases = summaries(beta, 'beta');
  if (betaReleases.some((release) => release.activeArtifacts.some((artifact) => artifact.versionCode > versionCode))) {
    throw new Error('Beta contains a newer versionCode; refusing a downgrade');
  }
  return betaReleases;
}

function editReleases(input: unknown, track: Track): JsonRecord[] {
  const response = record(input);
  if (response['track'] !== track) throw new Error('Google Play edit returned the wrong track');
  const releases = response['releases'] ?? [];
  if (!Array.isArray(releases)) throw new Error('Google Play edit returned invalid releases');
  return releases.map((release) => {
    const parsed = record(release);
    if (!Array.isArray(parsed['versionCodes']) || parsed['versionCodes'].length === 0) {
      throw new Error('Google Play edit returned invalid versionCodes');
    }
    for (const code of parsed['versionCodes']) {
      if (typeof code !== 'string') throw new Error('Google Play edit returned invalid versionCode');
      parseExpectedVersionCode(code);
    }
    return parsed;
  });
}

function selectedRelease(internal: unknown, beta: unknown, versionCode: number) {
  const source = editReleases(internal, 'internal').filter((release) =>
    (release['versionCodes'] as string[]).includes(String(versionCode)),
  );
  if (source.length !== 1 || source[0]!['status'] !== 'completed') {
    throw new Error('Expected exactly one completed internal release for ANDROID_VERSION_CODE');
  }
  const betaReleases = editReleases(beta, 'beta');
  if (
    betaReleases.some((release) => (release['versionCodes'] as string[]).some((code) => Number(code) > versionCode))
  ) {
    throw new Error('Beta edit contains a newer versionCode; refusing a downgrade');
  }
  const sourceRelease = source[0]!;
  const release: JsonRecord = { versionCodes: [String(versionCode)], status: 'completed' };
  if (sourceRelease['name'] !== undefined) {
    if (typeof sourceRelease['name'] !== 'string') throw new Error('Google Play edit returned invalid release name');
    release['name'] = sourceRelease['name'];
  }
  if (sourceRelease['releaseNotes'] !== undefined) {
    if (!Array.isArray(sourceRelease['releaseNotes']))
      throw new Error('Google Play edit returned invalid release notes');
    release['releaseNotes'] = sourceRelease['releaseNotes'].map((note) => {
      const parsed = record(note);
      if (typeof parsed['language'] !== 'string' || typeof parsed['text'] !== 'string') {
        throw new Error('Google Play edit returned invalid release notes');
      }
      return { language: parsed['language'], text: parsed['text'] };
    });
  }
  const matches = betaReleases.filter((entry) => (entry['versionCodes'] as string[]).includes(String(versionCode)));
  if (matches.length > 1) throw new Error('Beta edit contains ambiguous releases for ANDROID_VERSION_CODE');
  return { release, alreadyCompleted: matches.length === 1 && matches[0]!['status'] === 'completed' };
}

export async function promoteAndroidBeta(options: { accessToken: string; versionCode: number; apply?: boolean }) {
  const { accessToken, versionCode, apply = false } = options;
  parseExpectedVersionCode(String(versionCode));
  async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${APPLICATION_URL}${path}`, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Google Play beta request failed');
    }
    if (!response.ok) throw new Error(`Google Play beta request returned HTTP ${response.status}`);
    if (response.status === 204 && method === 'GET' && /^\/tracks\/(internal|beta)\/releases$/.test(path)) {
      return { releases: [] };
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`Google Play beta request returned invalid JSON (${method} ${path}, HTTP ${response.status})`);
    }
  }
  const internal = await request('/tracks/internal/releases');
  const beta = await request('/tracks/beta/releases');
  const betaReleases = checkSummaries(internal, beta, versionCode);
  if (!apply) {
    // PUBLISHED also includes partial and halted rollouts. A lifecycle-only
    // plan cannot establish whether the requested build is already at 100%.
    return { action: 'plan', versionCode, targetTrack: 'beta', betaReleases, rolloutStatus: 'unknown' };
  }

  // No retries or cleanup edits: a review conflict must fail visibly, and a
  // failed edit expires without deleting any pre-existing console work.
  const created = record(await request('/edits', 'POST', {}));
  if (typeof created['id'] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(created['id'])) {
    throw new Error('Google Play returned invalid edit identity');
  }
  const editPath = `/edits/${created['id']}`;
  const internalEdit = await request(`${editPath}/tracks/internal`);
  const betaEdit = await request(`${editPath}/tracks/beta`);
  const { release, alreadyCompleted } = selectedRelease(internalEdit, betaEdit, versionCode);
  const alreadyPublished = betaReleases.some(
    (entry) =>
      entry.releaseLifecycleState === PUBLISHED &&
      entry.activeArtifacts.some((artifact) => artifact.versionCode === versionCode),
  );
  if (alreadyCompleted && alreadyPublished) {
    return { action: 'already-completed', versionCode, targetTrack: 'beta', betaReleases, rolloutStatus: 'completed' };
  }
  await request(`${editPath}/tracks/beta`, 'PUT', { track: 'beta', releases: [release] });
  await request(`${editPath}:validate`, 'POST');
  await request(`${editPath}:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW`, 'POST');
  // Committing only submits changes. Read the lifecycle independently: review
  // and managed publishing can still prevent Play from serving the build.
  const receipt = summaries(await request('/tracks/beta/releases'), 'beta');
  const matching = receipt.filter((entry) =>
    entry.activeArtifacts.some((artifact) => artifact.versionCode === versionCode),
  );
  return {
    action: 'committed',
    versionCode,
    targetTrack: 'beta',
    betaReleases: receipt,
    publicationVerified: matching.length === 1 && matching[0]!.releaseLifecycleState === PUBLISHED,
    message: 'Commit accepted; the release lifecycle receipt determines publication. Tester delivery is not verified.',
  };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== '--apply')) throw new Error('Only --apply is supported');
    const versionCode = parseExpectedVersionCode(process.env['ANDROID_VERSION_CODE'] ?? '');
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    const accessToken = await createAuditAccessToken(secret);
    const report = await promoteAndroidBeta({ accessToken, versionCode, apply: args.includes('--apply') });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env['STORE_BETA_OUTPUT']) writeFileSync(process.env['STORE_BETA_OUTPUT'], output);
    console.log(output);
    return 0;
  } catch (error) {
    console.error(`[mobile-store-android-beta] ${error instanceof Error ? error.message : 'Operation failed'}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((exitCode) => process.exit(exitCode));
}
