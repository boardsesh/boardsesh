/// <reference types="node" />

// The Android half of the manual build-pair submission (mobile-store-submit.yml)
// and of its readiness check on selected releases: where one release version stands on
// Google Play, and, with --apply, releasing its exact build to production at 100%.
// The release itself is Android Production Release's own code
// (promoteAndroidProduction in mobile-store-android-production.ts), which commits
// with changesInReviewBehavior=ERROR_IF_IN_REVIEW.
//
//   --status   GET-only. Classifies ANDROID_VERSION_CODES (every build tag of the
//              version, space- or comma-separated) against production and beta.
//   (none)     GET-only plan for ANDROID_VERSION_CODE.
//   --apply    Releases ANDROID_VERSION_CODE at 100% when nothing stands in the way.
//
// Statuses, shared with the iOS lane `ios submission_status`:
//   pending     nothing blocks a release; the submit job may run
//   done        production already carries the build in review, approved or live
//   deferred    Play is reviewing a release on production or beta, and Play's
//               review lock is package-wide; the next run retries
//   blocked     a person has to act: Play rejected the build, the version has no
//               tagged build, or Play's internal track has moved on to a newer
//               build (Android Production Release only releases what internal
//               holds). Re-read every run, so it clears if the cause does.
//   superseded  production carries a newer build; releasing this one would go back
// Only real errors exit non-zero. A deferred, done, blocked or superseded build is
// a successful run with a notice, so the scheduled retry stays quiet and green.

import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createPlayRequest, trackSummaries } from './lib/google-play-tracks';
import { createAuditAccessToken, parseExpectedVersionCode } from './mobile-store-android-audit';
import { promoteAndroidProduction } from './mobile-store-android-production';

export type AndroidSubmissionStatus = 'pending' | 'done' | 'deferred' | 'blocked' | 'superseded';
export type TrackReleases = ReturnType<typeof trackSummaries>;
export type AndroidSubmissionDecision = { status: AndroidSubmissionStatus; reason: string };

const STATE_PREFIX = 'RELEASE_LIFECYCLE_STATE_';
const IN_REVIEW = `${STATE_PREFIX}IN_REVIEW`;
const NOT_APPROVED = `${STATE_PREFIX}NOT_APPROVED`;
const PUBLISHED = `${STATE_PREFIX}PUBLISHED`;
/** The build has been sent for review at least once and Play has not said no. */
const SUBMITTED_STATES = new Set([IN_REVIEW, `${STATE_PREFIX}APPROVED_NOT_PUBLISHED`, `${STATE_PREFIX}PUBLISHED`]);

function shortState(state: string): string {
  return state.startsWith(STATE_PREFIX) ? state.slice(STATE_PREFIX.length) : state;
}

/** PURE: where the version's builds (all its versionCodes) stand on Play. */
export function classifyAndroidSubmission(input: {
  versionCodes: readonly number[];
  production: TrackReleases;
  beta: TrackReleases;
  internal: TrackReleases;
}): AndroidSubmissionDecision {
  const ours = new Set(input.versionCodes);
  const carriesOurs = (release: TrackReleases[number]) =>
    release.activeArtifacts.some((artifact) => ours.has(artifact.versionCode));
  const productionOurs = input.production.filter(carriesOurs);
  const codes = [...ours].join(', ');

  const submitted = productionOurs.find((release) => SUBMITTED_STATES.has(release.releaseLifecycleState));
  if (submitted) {
    return {
      status: 'done',
      reason: `Production already carries versionCode ${codes} (${shortState(submitted.releaseLifecycleState)}).`,
    };
  }
  if (productionOurs.some((release) => release.releaseLifecycleState === NOT_APPROVED)) {
    return {
      status: 'blocked',
      reason: `Play rejected versionCode ${codes} on production. Select a corrected tester build from main, or resolve it in Play Console.`,
    };
  }
  if (input.versionCodes.length === 0) {
    return {
      status: 'blocked',
      reason:
        'No Android build is tagged for this version, so there is nothing to release. A tester build must be uploaded first.',
    };
  }
  const highest = Math.max(...input.versionCodes);
  const newer = input.production.filter((release) =>
    release.activeArtifacts.some((artifact) => artifact.versionCode > highest),
  );
  if (newer.length > 0) {
    return {
      status: 'superseded',
      reason: `Production already carries a newer build (${newer.map((release) => shortState(release.releaseLifecycleState)).join(', ')}); not releasing versionCode ${codes}.`,
    };
  }
  if (!input.internal.some((release) => release.releaseLifecycleState === PUBLISHED && carriesOurs(release))) {
    return {
      status: 'blocked',
      reason: `Play's internal track no longer serves versionCode ${codes} (a newer build replaced it), and Android Production Release only releases what internal holds. Release it by hand in Play Console, or select the latest tester version.`,
    };
  }
  const inReview = [
    ...input.production.filter((release) => release.releaseLifecycleState === IN_REVIEW).map(() => 'production'),
    ...input.beta.filter((release) => release.releaseLifecycleState === IN_REVIEW).map(() => 'open testing (beta)'),
  ];
  if (inReview.length > 0) {
    return {
      status: 'deferred',
      reason: `Play is reviewing a release on ${[...new Set(inReview)].join(' and ')}, and its review lock is package-wide; the next run retries once that review ends.`,
    };
  }
  return { status: 'pending', reason: `versionCode ${codes} can be released to production.` };
}

async function readDecision(accessToken: string, versionCodes: readonly number[]) {
  const request = createPlayRequest(accessToken, 'manual store submission');
  const production = trackSummaries(await request('/tracks/production/releases'), 'production');
  const beta = trackSummaries(await request('/tracks/beta/releases'), 'beta');
  const internal = trackSummaries(await request('/tracks/internal/releases'), 'internal');
  return classifyAndroidSubmission({ versionCodes, production, beta, internal });
}

/** GET-only: the decision for every build of the version. */
export async function androidSubmissionStatus(options: { accessToken: string; versionCodes: readonly number[] }) {
  for (const versionCode of options.versionCodes) parseExpectedVersionCode(String(versionCode));
  return readDecision(options.accessToken, options.versionCodes);
}

/**
 * PURE: Play refused the edit commit because something is in review. Play's review
 * lock covers listing changes too, which the release summaries do not show, so the
 * refusal text is the only sign of those. Only Google's own message counts (the
 * request path names changesInReviewBehavior itself), and its
 * changesNotSentForReview complaint is a real error, not a wait.
 */
export function isInReviewRefusal(message: string): boolean {
  const commit = message.indexOf(':commit?');
  const detailStart = message.indexOf('): ', commit);
  if (commit === -1 || detailStart === -1) return false;
  const detail = message.slice(detailStart + 3);
  return /\b(in review|under review|being reviewed)\b/i.test(detail) && !/changesNotSentForReview/i.test(detail);
}

/**
 * Plan, or with `apply` release the exact build to production at 100%. A commit
 * Play refuses is read again: a review that is now pending (someone else's, or
 * ours after an ambiguous response) is deferred or done, not a failure. So is a
 * refusal whose own text says changes are in review (a listing change, say).
 */
export async function submitAndroidProduction(options: { accessToken: string; versionCode: number; apply: boolean }) {
  const { accessToken, versionCode, apply } = options;
  parseExpectedVersionCode(String(versionCode));
  const before = await readDecision(accessToken, [versionCode]);
  if (before.status !== 'pending') return { action: 'none', versionCode, ...before };
  if (!apply) {
    const plan = await promoteAndroidProduction({ accessToken, versionCode, rolloutPercent: 100, apply: false });
    return { action: 'plan', versionCode, ...before, plan };
  }
  try {
    const receipt = await promoteAndroidProduction({ accessToken, versionCode, rolloutPercent: 100, apply: true });
    if (receipt.action === 'already-released') {
      return {
        action: 'none',
        versionCode,
        status: 'done',
        reason: 'Production already serves this build at 100%.',
        receipt,
      };
    }
    return {
      action: 'submitted',
      versionCode,
      status: 'done',
      reason: 'Committed to production at 100%; Play releases it once review approves it.',
      receipt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Release failed';
    let after: AndroidSubmissionDecision | null = null;
    try {
      after = await readDecision(accessToken, [versionCode]);
    } catch {
      after = null;
    }
    if (after && (after.status === 'deferred' || after.status === 'done')) {
      return { action: 'none', versionCode, ...after, refusal: message };
    }
    if (isInReviewRefusal(message)) {
      return {
        action: 'none',
        versionCode,
        status: 'deferred',
        reason:
          'Play refused the commit because changes are in review (its review lock covers listing changes too); the next run retries.',
        refusal: message,
      };
    }
    throw error;
  }
}

export function parseVersionCodeList(input: string): number[] {
  const parts = input.split(/[\s,]+/).filter(Boolean);
  return [...new Set(parts.map((part) => parseExpectedVersionCode(part)))];
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some((argument) => argument !== '--apply' && argument !== '--status')) {
      throw new Error('Usage: [--status | --apply]');
    }
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    const report = args.includes('--status')
      ? {
          action: 'status',
          ...(await androidSubmissionStatus({
            accessToken: await createAuditAccessToken(secret),
            versionCodes: parseVersionCodeList(process.env['ANDROID_VERSION_CODES'] ?? ''),
          })),
        }
      : await submitAndroidProduction({
          accessToken: await createAuditAccessToken(secret),
          versionCode: parseExpectedVersionCode(process.env['ANDROID_VERSION_CODE'] ?? ''),
          apply: args.includes('--apply'),
        });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env['STORE_SUBMIT_ANDROID_OUTPUT']) writeFileSync(process.env['STORE_SUBMIT_ANDROID_OUTPUT'], output);
    if (process.env['GITHUB_OUTPUT']) {
      appendFileSync(process.env['GITHUB_OUTPUT'], `status=${report.status}\naction=${report.action}\n`);
    }
    console.log(output);
    const annotation = report.status === 'blocked' || report.status === 'superseded' ? 'warning' : 'notice';
    if (process.env['GITHUB_ACTIONS']) console.log(`::${annotation}::Android: ${report.status}. ${report.reason}`);
    return 0;
  } catch (error) {
    console.error(`[mobile-store-submit-android] ${error instanceof Error ? error.message : 'Operation failed'}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((exitCode) => process.exit(exitCode));
}
