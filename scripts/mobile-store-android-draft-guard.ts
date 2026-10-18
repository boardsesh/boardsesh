/// <reference types="node" />

// Decides whether the store-draft workflow may (re)draft an Android build on the
// production track. fastlane's promote replaces the production track's releases
// with the build as a draft, so once that build has been released (in review,
// rolling out or live) a later store-draft run must leave production alone. The
// same holds while any other build is pending review: the promote's commit does
// not refuse a pending review, so it could cancel it.
// GET-only: reads the non-edit release summaries and never opens an edit.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createPlayRequest, trackSummaries } from './lib/google-play-tracks';
import { createAuditAccessToken, parseExpectedVersionCode } from './mobile-store-android-audit';

const DRAFT = 'RELEASE_LIFECYCLE_STATE_DRAFT';
// A release on its way to production. fastlane's promote commits without
// ERROR_IF_IN_REVIEW, so drafting another build now could cancel that review.
const PENDING = new Set([
  'RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW',
  'RELEASE_LIFECYCLE_STATE_IN_REVIEW',
  'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
]);

export function productionDraftDecision(
  releases: ReturnType<typeof trackSummaries>,
  versionCode: number,
): { skip: boolean; reason: string } {
  for (const release of releases) {
    const codes = release.activeArtifacts.map((artifact) => artifact.versionCode);
    // A newer build in any state, its draft included, must survive: promoting replaces the whole track.
    if (codes.some((code) => code > versionCode)) {
      return {
        skip: true,
        reason: `Production already carries a newer versionCode than ${versionCode} (${release.releaseLifecycleState}); refusing to draft over it.`,
      };
    }
    if (codes.includes(versionCode) && release.releaseLifecycleState !== DRAFT) {
      return {
        skip: true,
        reason: `versionCode ${versionCode} is already past draft on production (${release.releaseLifecycleState}); leaving it alone.`,
      };
    }
  }
  // Checked after the loop above, so the build's own state wins its message.
  for (const release of releases) {
    if (PENDING.has(release.releaseLifecycleState)) {
      const codes = release.activeArtifacts.map((artifact) => artifact.versionCode).join(', ');
      return {
        skip: true,
        reason: `Production has versionCode ${codes} pending (${release.releaseLifecycleState}); drafting ${versionCode} now could cancel that review.`,
      };
    }
  }
  return { skip: false, reason: `versionCode ${versionCode} is not released on production yet; drafting is safe.` };
}

export async function checkProductionDraft(options: { accessToken: string; versionCode: number }) {
  parseExpectedVersionCode(String(options.versionCode));
  const request = createPlayRequest(options.accessToken, 'production draft guard');
  const releases = trackSummaries(await request('/tracks/production/releases'), 'production');
  return productionDraftDecision(releases, options.versionCode);
}

async function main() {
  try {
    const versionCode = parseExpectedVersionCode(process.env['ANDROID_VERSION_CODE'] ?? '');
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    const decision = await checkProductionDraft({ accessToken: await createAuditAccessToken(secret), versionCode });
    console.log(decision.reason);
    if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `skip=${decision.skip}\n`);
    return 0;
  } catch (error) {
    console.error(`[mobile-store-android-draft-guard] ${error instanceof Error ? error.message : 'Operation failed'}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((exitCode) => process.exit(exitCode));
}
