/// <reference types="node" />

// Shared Google Play Developer API plumbing for the exact-build promotion scripts
// (open testing and production). Each script owns its own track rules; this file
// owns the parsing and request shape they have in common.

import { parseGoogleProductionReleasesResponse } from '../mobile-auto-version-bump';
import { parseExpectedVersionCode } from '../mobile-store-android-audit';

const APPLICATION_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.boardsesh.app';
export const PUBLISHED = 'RELEASE_LIFECYCLE_STATE_PUBLISHED';

export type PlayTrack = 'internal' | 'beta' | 'production';
export type JsonRecord = Record<string, unknown>;
export type PlayRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;

export function record(input: unknown): JsonRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Google Play returned an invalid object');
  }
  return input as JsonRecord;
}

/** Lifecycle summaries from the non-edit `tracks/{track}/releases` read. */
export function trackSummaries(input: unknown, track: PlayTrack) {
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

/** Releases from an edit's `tracks/{track}` read, with validated versionCodes. */
export function editReleases(input: unknown, track: PlayTrack): JsonRecord[] {
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

export function releaseVersionCodes(release: JsonRecord): string[] {
  return release['versionCodes'] as string[];
}

export function hasNewerVersionCode(release: JsonRecord, versionCode: number): boolean {
  return releaseVersionCodes(release).some((code) => Number(code) > versionCode);
}

/**
 * Copy only a release's name and release notes, validated. Anything else Google
 * returns (country targeting, fractions, unknown fields) is deliberately dropped.
 */
export function releaseIdentity(source: JsonRecord): JsonRecord {
  const identity: JsonRecord = {};
  if (source['name'] !== undefined) {
    if (typeof source['name'] !== 'string') throw new Error('Google Play edit returned invalid release name');
    identity['name'] = source['name'];
  }
  if (source['releaseNotes'] !== undefined) {
    if (!Array.isArray(source['releaseNotes'])) throw new Error('Google Play edit returned invalid release notes');
    identity['releaseNotes'] = source['releaseNotes'].map((note) => {
      const parsed = record(note);
      if (typeof parsed['language'] !== 'string' || typeof parsed['text'] !== 'string') {
        throw new Error('Google Play edit returned invalid release notes');
      }
      return { language: parsed['language'], text: parsed['text'] };
    });
  }
  return identity;
}

/** The one PUBLISHED internal release that carries the build, from a non-edit read. */
export function requirePublishedInternal(internal: unknown, versionCode: number): void {
  const source = trackSummaries(internal, 'internal').filter((release) =>
    release.activeArtifacts.some((artifact) => artifact.versionCode === versionCode),
  );
  if (source.length !== 1 || source[0]!.releaseLifecycleState !== PUBLISHED) {
    throw new Error('Expected exactly one PUBLISHED internal release for ANDROID_VERSION_CODE');
  }
}

/**
 * The completed internal release carrying the build, inside an edit, reduced to
 * a single-artifact release that can be written to another track.
 */
export function releaseFromInternalEdit(internalEdit: unknown, versionCode: number): JsonRecord {
  const source = editReleases(internalEdit, 'internal').filter((release) =>
    releaseVersionCodes(release).includes(String(versionCode)),
  );
  if (source.length !== 1 || source[0]!['status'] !== 'completed') {
    throw new Error('Expected exactly one completed internal release for ANDROID_VERSION_CODE');
  }
  return { versionCodes: [String(versionCode)], status: 'completed', ...releaseIdentity(source[0]!) };
}

/**
 * A Play Developer API client bound to one access token. Errors name only the
 * label, method and status: never a response body, which can quote credentials.
 */
export function createPlayRequest(accessToken: string, label: string): PlayRequest {
  return async (path, method = 'GET', body) => {
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
      throw new Error(`Google Play ${label} request failed`);
    }
    if (!response.ok) throw new Error(`Google Play ${label} request returned HTTP ${response.status}`);
    if (response.status === 204 && method === 'GET' && /^\/tracks\/(internal|beta|production)\/releases$/.test(path)) {
      return { releases: [] };
    }
    // edits.delete answers 204 with no body.
    if (response.status === 204 && method === 'DELETE') return {};
    try {
      return await response.json();
    } catch {
      throw new Error(
        `Google Play ${label} request returned invalid JSON (${method} ${path}, HTTP ${response.status})`,
      );
    }
  };
}

export async function openEdit(request: PlayRequest): Promise<string> {
  const created = record(await request('/edits', 'POST', {}));
  if (typeof created['id'] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(created['id'])) {
    throw new Error('Google Play returned invalid edit identity');
  }
  return `/edits/${created['id']}`;
}

/** Discard an edit this run opened and did not need. Only ever our own edit: never console work. */
export async function discardEdit(request: PlayRequest, editPath: string): Promise<void> {
  await request(editPath, 'DELETE');
}

/**
 * Validate, then commit for review. No retries or cleanup edits: a review
 * conflict must fail visibly, and a failed edit expires without deleting any
 * pre-existing console work.
 */
export async function validateAndCommit(request: PlayRequest, editPath: string): Promise<void> {
  await request(`${editPath}:validate`, 'POST');
  await request(`${editPath}:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW`, 'POST');
}
