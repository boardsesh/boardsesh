/// <reference types="node" />

// Answers one question before the Android release build spends ~30 minutes: is a
// Play release waiting for review? Play's review lock is package-wide, and
// `fastlane android upload_beta` commits with ERROR_IF_IN_REVIEW, so while a
// production or open-testing release is in review the upload is refused and the
// whole build is wasted. GET-only: reads the non-edit release summaries and never
// opens an edit.
//
// Fails OPEN. A track it cannot read counts as "nothing pending": the upload keeps
// its own review guard, so a wrong "no" costs one wasted build, while a wrong
// "yes" would quietly hold every native tester build.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { type PlayTrack, createPlayRequest, trackSummaries } from './lib/google-play-tracks';
import { createAuditAccessToken, parseExpectedVersionCode } from './mobile-store-android-audit';

const IN_REVIEW = 'RELEASE_LIFECYCLE_STATE_IN_REVIEW';

/** The tracks whose reviews block a tester upload. Internal releases are not reviewed. */
export const REVIEWED_TRACKS: readonly PlayTrack[] = ['production', 'beta'];

export type TrackReleases = { track: PlayTrack; releases: ReturnType<typeof trackSummaries> };
export type ReviewDecision = { pending: boolean; reason: string };
export type ReviewCommitBehavior = 'ERROR_IF_IN_REVIEW' | 'CANCEL_IN_REVIEW_AND_SUBMIT';

/** Manual replacement authorizes exactly one beta review, never a production review. */
export function betaReviewReplacementBehavior(
  tracks: readonly TrackReleases[],
  expectedVersionCode: number,
): ReviewCommitBehavior {
  parseExpectedVersionCode(String(expectedVersionCode));
  if (
    tracks.length !== REVIEWED_TRACKS.length ||
    REVIEWED_TRACKS.some((track) => tracks.filter((entry) => entry.track === track).length !== 1)
  )
    throw new Error('Both production and beta review states are required for replacement.');
  const production = tracks.find((entry) => entry.track === 'production')!;
  if (production.releases.some((release) => release.releaseLifecycleState === IN_REVIEW))
    throw new Error('A production release is in review; refusing beta review replacement.');
  const beta = tracks.find((entry) => entry.track === 'beta')!;
  const reviewed = beta.releases.filter((release) => release.releaseLifecycleState === IN_REVIEW);
  if (reviewed.length === 0) return 'ERROR_IF_IN_REVIEW';
  if (
    reviewed.length !== 1 ||
    reviewed[0]!.activeArtifacts.length !== 1 ||
    reviewed[0]!.activeArtifacts[0]!.versionCode !== expectedVersionCode
  )
    throw new Error('The pending beta review no longer matches the explicitly selected versionCode.');
  return 'CANCEL_IN_REVIEW_AND_SUBMIT';
}

export function reviewPendingDecision(tracks: readonly TrackReleases[]): ReviewDecision {
  const inReview = tracks.flatMap(({ track, releases }) =>
    releases
      .filter((release) => release.releaseLifecycleState === IN_REVIEW)
      .map((release) => {
        const codes = release.activeArtifacts.map((artifact) => artifact.versionCode).join(', ');
        return codes ? `${track} (versionCode ${codes})` : track;
      }),
  );
  if (inReview.length > 0) {
    return {
      pending: true,
      reason: `Play is reviewing a release on ${inReview.join(' and ')}, and the upload cannot commit until that review finishes.`,
    };
  }
  return {
    pending: false,
    reason: `No release on ${REVIEWED_TRACKS.join(' or ')} is in review; the upload can commit.`,
  };
}

async function readReviewedTracks(accessToken: string): Promise<TrackReleases[]> {
  const request = createPlayRequest(accessToken, 'review check');
  const tracks: TrackReleases[] = [];
  for (const track of REVIEWED_TRACKS) {
    tracks.push({ track, releases: trackSummaries(await request(`/tracks/${track}/releases`), track) });
  }
  return tracks;
}

export async function checkReviewPending(options: { accessToken: string }): Promise<ReviewDecision> {
  return reviewPendingDecision(await readReviewedTracks(options.accessToken));
}

export async function authorizeBetaReviewReplacement(options: {
  accessToken: string;
  expectedVersionCode: number;
}): Promise<ReviewCommitBehavior> {
  parseExpectedVersionCode(String(options.expectedVersionCode));
  return betaReviewReplacementBehavior(await readReviewedTracks(options.accessToken), options.expectedVersionCode);
}

/** Any failure to read Play becomes "not pending", with the cause kept in the reason. */
export async function reviewPendingOrFailOpen(
  read: () => Promise<ReviewDecision>,
): Promise<ReviewDecision & { failedOpen: boolean }> {
  try {
    return { ...(await read()), failedOpen: false };
  } catch (error) {
    // Errors from the shared Play helpers name only the request and its HTTP
    // status, never a response body, so the message is safe to log.
    const cause = error instanceof Error ? error.message : 'unknown error';
    return {
      pending: false,
      failedOpen: true,
      reason: `Could not read the Play review state (${cause}); building anyway, because the upload keeps its own review guard.`,
    };
  }
}

async function main(): Promise<number> {
  const flags = process.argv.slice(2);
  if (flags.length > 1 || (flags.length === 1 && flags[0] !== '--commit-behavior'))
    throw new Error('Only --commit-behavior is supported.');
  const replacementCode = process.env['REPLACE_BETA_REVIEW_VERSION_CODE'];
  if (replacementCode || flags[0] === '--commit-behavior') {
    const expectedVersionCode = parseExpectedVersionCode(replacementCode ?? '');
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not set');
    const behavior = await authorizeBetaReviewReplacement({
      accessToken: await createAuditAccessToken(secret),
      expectedVersionCode,
    });
    if (flags[0] === '--commit-behavior') {
      console.log(behavior);
    } else {
      console.log(`Manual beta review replacement authorized for versionCode ${expectedVersionCode}.`);
      if (process.env['GITHUB_OUTPUT'])
        appendFileSync(process.env['GITHUB_OUTPUT'], 'pending=false\nreplacement_authorized=true\n');
    }
    return 0;
  }
  const decision = await reviewPendingOrFailOpen(async () => {
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not set');
    return checkReviewPending({ accessToken: await createAuditAccessToken(secret) });
  });
  console.log(decision.failedOpen ? `::warning::${decision.reason}` : decision.reason);
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (outputPath) appendFileSync(outputPath, `pending=${decision.pending}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(
    (exitCode) => process.exit(exitCode),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Play review preflight failed.');
      process.exitCode = 1;
    },
  );
}
