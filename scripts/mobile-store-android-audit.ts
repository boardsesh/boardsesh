/// <reference types="node" />

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  createGoogleAccessToken,
  parseGoogleProductionReleasesResponse,
  parseGoogleServiceAccount,
} from './mobile-auto-version-bump';

const PACKAGE_NAME = 'com.boardsesh.app';
const RELEASES_URL = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/tracks/production/releases`;

export async function createAuditAccessToken(secret: string): Promise<string> {
  try {
    return await createGoogleAccessToken(parseGoogleServiceAccount(secret));
  } catch {
    // JSON parsing and the shared OAuth helper can include raw input/response
    // fragments in their errors. Keep credentials out of this workflow's logs.
    throw new Error('Google Play authentication failed; check the Production service-account credential');
  }
}

// This endpoint is outside the Edits API: reading it cannot invalidate an open
// edit. It exposes release lifecycle states, not notes or publishing settings.
// https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list
export async function readProductionReleaseSummaries(accessToken: string): Promise<unknown> {
  const response = await fetch(RELEASES_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  // Do not include response bodies in errors: only the whitelisted release
  // fields below belong in the retained report or workflow log.
  if (!response.ok) throw new Error(`Google Play production release audit returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('Google Play production release audit returned invalid JSON');
  }
}

export function parseExpectedVersionCode(input: string): number {
  if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input))) {
    throw new Error('ANDROID_VERSION_CODE must be a positive safe integer');
  }
  return Number(input);
}

export function buildAndroidReleaseAudit(input: unknown, expectedVersionCode: number) {
  parseExpectedVersionCode(String(expectedVersionCode));
  const parsed = parseGoogleProductionReleasesResponse(input);
  const rawReleases = (input as { releases: Array<Record<string, unknown>> }).releases;
  const releases = parsed.map((release, index) => {
    const rawRelease = rawReleases[index]!;
    const releaseName = rawRelease['releaseName'];
    const track = rawRelease['track'];
    if (releaseName !== undefined && typeof releaseName !== 'string') {
      throw new Error(`Google Play release ${index} has an invalid releaseName`);
    }
    if (track !== undefined && track !== 'production') {
      throw new Error(`Google Play release ${index} does not belong to the production track`);
    }
    return { releaseName: releaseName ?? null, track: track ?? null, ...release };
  });
  const matches = releases.filter((release) =>
    release.activeArtifacts.some((artifact) => artifact.versionCode === expectedVersionCode),
  );
  return {
    platform: 'android',
    auditedAt: new Date().toISOString(),
    packageName: PACKAGE_NAME,
    requestedTrack: 'production',
    expectedVersionCode,
    sourceEndpoint: RELEASES_URL,
    identityErrors:
      matches.length === 1
        ? []
        : [`Expected one production release containing versionCode ${expectedVersionCode}; found ${matches.length}`],
    matchingReleases: matches,
    releases,
    limitations: [
      'Release notes are not exposed by this endpoint and were not verified.',
      'Managed publishing status is not exposed by this endpoint and was not verified.',
      'Version name and source commit were not verified; identity uses the exact versionCode.',
      'The API returns up to 20 non-obsolete releases; absence does not prove a build was never uploaded.',
    ],
  };
}

async function main(): Promise<number> {
  try {
    const expectedVersionCode = parseExpectedVersionCode(process.env['ANDROID_VERSION_CODE'] ?? '2001247');
    const outputPath = process.env['STORE_AUDIT_OUTPUT'];
    if (!outputPath) throw new Error('Missing STORE_AUDIT_OUTPUT');
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    const accessToken = await createAuditAccessToken(secret);
    const response = await readProductionReleaseSummaries(accessToken);
    const report = buildAndroidReleaseAudit(response, expectedVersionCode);
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.identityErrors.length > 0) throw new Error(report.identityErrors.join('; '));
    console.log(`Android versionCode ${expectedVersionCode}: ${report.matchingReleases[0]!.releaseLifecycleState}`);
    console.log('Read-only release state retained. Release notes and managed publishing remain unverified.');
    return 0;
  } catch (error) {
    console.error(`[mobile-store-android-audit] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((exitCode) => process.exit(exitCode));
}
