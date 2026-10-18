/// <reference types="node" />

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  PUBLISHED,
  createPlayRequest,
  editReleases,
  hasNewerVersionCode,
  openEdit,
  releaseFromInternalEdit,
  releaseVersionCodes,
  requirePublishedInternal,
  trackSummaries,
  validateAndCommit,
} from './lib/google-play-tracks';
import { createAuditAccessToken, parseExpectedVersionCode } from './mobile-store-android-audit';

function checkSummaries(internal: unknown, beta: unknown, versionCode: number) {
  requirePublishedInternal(internal, versionCode);
  const betaReleases = trackSummaries(beta, 'beta');
  if (betaReleases.some((release) => release.activeArtifacts.some((artifact) => artifact.versionCode > versionCode))) {
    throw new Error('Beta contains a newer versionCode; refusing a downgrade');
  }
  return betaReleases;
}

function selectedRelease(internal: unknown, beta: unknown, versionCode: number) {
  const release = releaseFromInternalEdit(internal, versionCode);
  const betaReleases = editReleases(beta, 'beta');
  if (betaReleases.some((entry) => hasNewerVersionCode(entry, versionCode))) {
    throw new Error('Beta edit contains a newer versionCode; refusing a downgrade');
  }
  const matches = betaReleases.filter((entry) => releaseVersionCodes(entry).includes(String(versionCode)));
  if (matches.length > 1) throw new Error('Beta edit contains ambiguous releases for ANDROID_VERSION_CODE');
  return { release, alreadyCompleted: matches.length === 1 && matches[0]!['status'] === 'completed' };
}

export async function promoteAndroidBeta(options: { accessToken: string; versionCode: number; apply?: boolean }) {
  const { accessToken, versionCode, apply = false } = options;
  parseExpectedVersionCode(String(versionCode));
  const request = createPlayRequest(accessToken, 'beta');
  const internal = await request('/tracks/internal/releases');
  const beta = await request('/tracks/beta/releases');
  const betaReleases = checkSummaries(internal, beta, versionCode);
  if (!apply) {
    // PUBLISHED also includes partial and halted rollouts. A lifecycle-only
    // plan cannot establish whether the requested build is already at 100%.
    return { action: 'plan', versionCode, targetTrack: 'beta', betaReleases, rolloutStatus: 'unknown' };
  }

  const editPath = await openEdit(request);
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
  await validateAndCommit(request, editPath);
  // Committing only submits changes. Read the lifecycle independently: review
  // and managed publishing can still prevent Play from serving the build.
  const receipt = trackSummaries(await request('/tracks/beta/releases'), 'beta');
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
