/// <reference types="node" />

/**
 * Pure helpers for the mobile release-anchoring tag scheme. Two tag families:
 *
 *   build-<platform>-v<version>-<buildNumber>-<shortfp>
 *     Pushed by the native build workflows (ios-testflight-rn.yml /
 *     android-apk-rn.yml) on a successful store upload. Maps a STORE BUILD NUMBER
 *     (iOS CFBundleVersion / Android versionCode) back to the exact commit and
 *     the canonical gate fingerprint the binary embeds. The store only ever tells
 *     us the *approved build number*, so this tag is the lookup that turns that
 *     number into a commit + fingerprint.
 *
 *   release/<platform>-v<version>-<shortfp>
 *     Cut by the approval workflow (mobile-auto-version-bump) when App Store
 *     Connect or Google Play reports a version accepted. Points at the commit the approved binary
 *     was built from; the <shortfp> in the name is the fingerprint an OTA must
 *     resolve to reach that release's installs. This frozen tag is the backport
 *     anchor: check it out, cherry-pick a JS fix, and publish an OTA under its
 *     fingerprint. See docs/mobile-ota-updates.md.
 *
 * These are string-only, so they unit-test without git or the network.
 */

export type Platform = 'ios' | 'android';

/** First 12 hex chars of a fingerprint. Long enough to be collision-free across
 * the handful of releases a repo ever ships, short enough to keep tag names sane. */
export const SHORT_FP_LENGTH = 12;

const VERSION_PATTERN = String.raw`\d+\.\d+\.\d+`;
const SHORT_FP_PATTERN = `[0-9a-f]{${SHORT_FP_LENGTH}}`;
const BUILD_TAG_RE = new RegExp(String.raw`^build-(ios|android)-v(${VERSION_PATTERN})-(\d+)-(${SHORT_FP_PATTERN})$`);
const RELEASE_TAG_RE = new RegExp(String.raw`^release/(ios|android)-v(${VERSION_PATTERN})-(${SHORT_FP_PATTERN})$`);

export type BuildTag = {
  platform: Platform;
  version: string;
  buildNumber: number;
  shortFp: string;
};

export type ReleaseTag = {
  platform: Platform;
  version: string;
  shortFp: string;
};

export type AcceptedBuildReference = {
  platform: Platform;
  versionString: string | null;
  buildNumber: number;
  state: string;
};

export type ReleaseCandidate = {
  ios: BuildTag;
  android: BuildTag;
};

/**
 * Find the highest build tag for each platform at one marketing version, then
 * require that exact build to be accepted. A newer pending build blocks instead
 * of falling back to an older accepted binary. This deliberately makes no claim
 * about native equivalence to main HEAD; an unprivileged workflow resolves
 * and compares the real Expo fingerprints before changing store state.
 */
export function selectHighestAcceptedBuildTags(
  tags: readonly string[],
  acceptedBuilds: readonly AcceptedBuildReference[],
  version: string,
): ReleaseCandidate | null {
  return selectReleaseCandidateFromEquivalentTags(tags, acceptedBuilds, version);
}

/** Truncate a full fingerprint to the tag-name form. Throws on a non-hex or
 * too-short input so a malformed gate value can't silently produce a bad tag. */
export function shortFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(trimmed) || trimmed.length < SHORT_FP_LENGTH) {
    throw new Error(`Not a resolvable fingerprint (need >= ${SHORT_FP_LENGTH} hex chars): ${fingerprint}`);
  }
  return trimmed.slice(0, SHORT_FP_LENGTH);
}

export function formatBuildTag(platform: Platform, version: string, buildNumber: number, shortFp: string): string {
  return `build-${platform}-v${version}-${buildNumber}-${shortFp}`;
}

export function formatReleaseTag(platform: Platform, version: string, shortFp: string): string {
  return `release/${platform}-v${version}-${shortFp}`;
}

export function parseBuildTag(tag: string): BuildTag | null {
  const match = BUILD_TAG_RE.exec(tag);
  if (!match) return null;
  return {
    platform: match[1] as Platform,
    version: match[2],
    buildNumber: Number.parseInt(match[3], 10),
    shortFp: match[4],
  };
}

export function parseReleaseTag(tag: string): ReleaseTag | null {
  const match = RELEASE_TAG_RE.exec(tag);
  if (!match) return null;
  return { platform: match[1] as Platform, version: match[2], shortFp: match[3] };
}

/**
 * From a list of tag names, pick the build tag that identifies the store binary
 * for (platform, version).
 *
 * When `preferredBuildNumber` is given, the store told us the EXACT approved build
 * number, so only that build's tag is a correct anchor — this returns the exact
 * match or `null` (it does NOT fall back to the highest build). Falling back would
 * anchor a different commit + fingerprint than the approved binary, silently
 * publishing backports that never reach it; returning null lets the caller warn
 * and skip, and a later run retries once the exact build tag exists.
 *
 * When `preferredBuildNumber` is omitted, it best-effort returns the highest build
 * number for that version. Release acceptance must use `pickExactBuildTag`,
 * because both stores now report exact build numbers.
 *
 * Returns `null` when no build tag matches the (platform, version) at all.
 */
export function pickBuildTagForVersion(
  tags: readonly string[],
  platform: Platform,
  version: string,
  preferredBuildNumber?: number,
): BuildTag | null {
  const candidates = tags
    .map(parseBuildTag)
    .filter(
      (parsed): parsed is BuildTag => parsed !== null && parsed.platform === platform && parsed.version === version,
    );

  if (candidates.length === 0) return null;

  if (preferredBuildNumber !== undefined) {
    return candidates.find((candidate) => candidate.buildNumber === preferredBuildNumber) ?? null;
  }

  return candidates.reduce((best, candidate) => (candidate.buildNumber > best.buildNumber ? candidate : best));
}

/**
 * Resolve the tag for one exact store-approved build. Google Play's production
 * release lifecycle endpoint reports versionCode but not a canonical versionName,
 * so `version` is optional. Build numbers are unique within an app; if malformed
 * duplicate tags disagree about the binary, fail closed instead of anchoring an
 * arbitrary commit.
 */
export function pickExactBuildTag(
  tags: readonly string[],
  platform: Platform,
  buildNumber: number,
  version?: string,
): BuildTag | null {
  const candidates = tags
    .map(parseBuildTag)
    .filter(
      (parsed): parsed is BuildTag =>
        parsed !== null &&
        parsed.platform === platform &&
        parsed.buildNumber === buildNumber &&
        (version === undefined || parsed.version === version),
    );

  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Select the exact accepted binaries whose marketing version and embedded native
 * fingerprints match the current main HEAD. Commit equality is
 * deliberately not required: later JS/backend-only main commits retain the
 * fingerprint and may ride OTA. Any missing or ambiguous platform match fails closed.
 */
export function selectReleaseCandidate(
  tags: readonly string[],
  acceptedBuilds: readonly AcceptedBuildReference[],
  version: string,
  fingerprints: Readonly<Record<Platform, string>>,
): ReleaseCandidate | null {
  const equivalentTags = tags.filter((tagName) => {
    const tag = parseBuildTag(tagName);
    return tag !== null && tag.shortFp === shortFingerprint(fingerprints[tag.platform]);
  });
  return selectReleaseCandidateFromEquivalentTags(equivalentTags, acceptedBuilds, version);
}

/**
 * Select the highest build per platform from build tags already proven native-
 * equivalent to main HEAD. The I/O shell can establish equivalence using a
 * trusted `git diff` over canonical native inputs without executing branch code.
 */
export function selectReleaseCandidateFromEquivalentTags(
  candidateTags: readonly string[],
  acceptedBuilds: readonly AcceptedBuildReference[],
  version: string,
): ReleaseCandidate | null {
  const parsedTags = candidateTags.map(parseBuildTag).filter((tag): tag is BuildTag => tag !== null);

  const selectPlatform = (platform: Platform): BuildTag | null => {
    const headCandidates = parsedTags.filter((tag) => tag.platform === platform && tag.version === version);
    if (headCandidates.length === 0) return null;
    const highestBuildNumber = Math.max(...headCandidates.map((tag) => tag.buildNumber));
    const highestBuildTags = headCandidates.filter((tag) => tag.buildNumber === highestBuildNumber);
    if (highestBuildTags.length !== 1) return null;

    const accepted = acceptedBuilds.some(
      (acceptedBuild) =>
        acceptedBuild.platform === platform &&
        acceptedBuild.buildNumber === highestBuildNumber &&
        (acceptedBuild.versionString === null || acceptedBuild.versionString === version),
    );
    return accepted ? highestBuildTags[0] : null;
  };

  const ios = selectPlatform('ios');
  const android = selectPlatform('android');
  return ios && android ? { ios, android } : null;
}

/** Bump the patch component of an x.y.z version string. */
export function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new Error(`Not an x.y.z version: ${version}`);
  return `${match[1]}.${match[2]}.${Number.parseInt(match[3], 10) + 1}`;
}
