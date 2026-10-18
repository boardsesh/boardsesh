/// <reference types="node" />

// Release one exact build that already sits on the Play internal track to
// production. Plan (GET-only) by default; `--apply` opens an edit, writes the
// production track and commits it for review. Same shape as the open-testing
// promotion in mobile-store-android-beta.ts.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  PUBLISHED,
  type JsonRecord,
  createPlayRequest,
  discardEdit,
  editReleases,
  hasNewerVersionCode,
  openEdit,
  releaseFromInternalEdit,
  releaseIdentity,
  releaseVersionCodes,
  requirePublishedInternal,
  trackSummaries,
  validateAndCommit,
} from './lib/google-play-tracks';
import { createAuditAccessToken, parseExpectedVersionCode } from './mobile-store-android-audit';

export function parseRolloutPercent(input: string): number {
  if (!/^(100|[1-9]\d?)$/.test(input)) throw new Error('Rollout percent must be a whole number from 1 to 100');
  return Number(input);
}

function checkSummaries(internal: unknown, production: unknown, versionCode: number) {
  requirePublishedInternal(internal, versionCode);
  const productionReleases = trackSummaries(production, 'production');
  if (
    productionReleases.some((release) => release.activeArtifacts.some((artifact) => artifact.versionCode > versionCode))
  ) {
    throw new Error('Production contains a newer versionCode; refusing a downgrade');
  }
  return productionReleases;
}

/**
 * The production track to write. At 100% the build is the only release, which
 * supersedes the live one and drops any draft. Below 100% the build rolls out as
 * `inProgress` beside the current completed release, which keeps serving
 * everyone outside the fraction.
 *
 * The release name and notes come from the build's existing production release
 * when it has them (the store-draft workflow's draft, perhaps edited by hand in
 * Play Console), otherwise from its internal release.
 */
function productionTrack(internalEdit: unknown, productionEdit: unknown, versionCode: number, rolloutPercent: number) {
  const internalRelease = releaseFromInternalEdit(internalEdit, versionCode);
  const current = editReleases(productionEdit, 'production');
  if (current.some((entry) => hasNewerVersionCode(entry, versionCode))) {
    throw new Error('Production edit contains a newer versionCode; refusing a downgrade');
  }
  const matches = current.filter((entry) => releaseVersionCodes(entry).includes(String(versionCode)));
  if (matches.length > 1) throw new Error('Production edit contains ambiguous releases for ANDROID_VERSION_CODE');
  const match = matches[0];
  const release: JsonRecord = { ...internalRelease, ...(match ? releaseIdentity(match) : {}) };

  if (rolloutPercent === 100) {
    return { releases: [release], alreadyApplied: match?.['status'] === 'completed' };
  }

  if (match?.['status'] === 'completed') {
    throw new Error('ANDROID_VERSION_CODE is already completed on production; a staged rollout cannot shrink it');
  }
  const userFraction = rolloutPercent / 100;
  const currentFraction = match?.['userFraction'];
  if (typeof currentFraction === 'number' && userFraction < currentFraction) {
    throw new Error(
      `ANDROID_VERSION_CODE already rolls out to ${Math.round(currentFraction * 100)}%; a staged rollout cannot shrink it`,
    );
  }
  const fallback = current.filter(
    (entry) => entry['status'] === 'completed' && !releaseVersionCodes(entry).includes(String(versionCode)),
  );
  if (fallback.length > 1) throw new Error('Production edit has more than one completed release');
  const fallbackReleases: JsonRecord[] = fallback.map((entry) => ({
    versionCodes: releaseVersionCodes(entry),
    status: 'completed',
    ...releaseIdentity(entry),
  }));
  return {
    releases: [{ ...release, status: 'inProgress', userFraction }, ...fallbackReleases],
    alreadyApplied: match?.['status'] === 'inProgress' && match['userFraction'] === userFraction,
  };
}

export async function promoteAndroidProduction(options: {
  accessToken: string;
  versionCode: number;
  rolloutPercent?: number;
  apply?: boolean;
}) {
  const { accessToken, versionCode, rolloutPercent = 100, apply = false } = options;
  parseExpectedVersionCode(String(versionCode));
  parseRolloutPercent(String(rolloutPercent));
  const request = createPlayRequest(accessToken, 'production');
  const internal = await request('/tracks/internal/releases');
  const production = await request('/tracks/production/releases');
  const productionReleases = checkSummaries(internal, production, versionCode);
  if (!apply) {
    // PUBLISHED also includes partial and halted rollouts, so a lifecycle-only
    // plan cannot say what fraction of the audience the build already reaches.
    return {
      action: 'plan',
      versionCode,
      targetTrack: 'production',
      rolloutPercent,
      productionReleases,
      rolloutStatus: 'unknown',
    };
  }

  const editPath = await openEdit(request);
  const internalEdit = await request(`${editPath}/tracks/internal`);
  const productionEdit = await request(`${editPath}/tracks/production`);
  const { releases, alreadyApplied } = productionTrack(internalEdit, productionEdit, versionCode, rolloutPercent);
  const notes = releases[0]!['releaseNotes'];
  const releaseNoteLanguages = Array.isArray(notes) ? notes.map((note) => (note as JsonRecord)['language']) : [];
  const alreadyPublished = productionReleases.some(
    (entry) =>
      entry.releaseLifecycleState === PUBLISHED &&
      entry.activeArtifacts.some((artifact) => artifact.versionCode === versionCode),
  );
  if (alreadyApplied && alreadyPublished) {
    // Nothing to write: drop the edit opened above rather than leave it pending until it expires.
    await discardEdit(request, editPath);
    return {
      action: 'already-released',
      versionCode,
      targetTrack: 'production',
      rolloutPercent,
      productionReleases,
      rolloutStatus: rolloutPercent === 100 ? 'completed' : 'inProgress',
    };
  }
  await request(`${editPath}/tracks/production`, 'PUT', { track: 'production', releases });
  await validateAndCommit(request, editPath);
  // Committing only submits changes. Read the lifecycle independently: review
  // and managed publishing can still keep Play from serving the build.
  const receipt = trackSummaries(await request('/tracks/production/releases'), 'production');
  const matching = receipt.filter((entry) =>
    entry.activeArtifacts.some((artifact) => artifact.versionCode === versionCode),
  );
  return {
    action: 'committed',
    versionCode,
    targetTrack: 'production',
    rolloutPercent,
    releaseNoteLanguages,
    productionReleases: receipt,
    publicationVerified: matching.length === 1 && matching[0]!.releaseLifecycleState === PUBLISHED,
    message: 'Commit accepted; the release lifecycle receipt determines publication. Device delivery is not verified.',
  };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== '--apply')) throw new Error('Only --apply is supported');
    const versionCode = parseExpectedVersionCode(process.env['ANDROID_VERSION_CODE'] ?? '');
    const rolloutPercent = parseRolloutPercent(process.env['ANDROID_ROLLOUT_PERCENT'] ?? '100');
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    const accessToken = await createAuditAccessToken(secret);
    const report = await promoteAndroidProduction({
      accessToken,
      versionCode,
      rolloutPercent,
      apply: args.includes('--apply'),
    });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env['STORE_PRODUCTION_OUTPUT']) writeFileSync(process.env['STORE_PRODUCTION_OUTPUT'], output);
    console.log(output);
    return 0;
  } catch (error) {
    console.error(`[mobile-store-android-production] ${error instanceof Error ? error.message : 'Operation failed'}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((exitCode) => process.exit(exitCode));
}
