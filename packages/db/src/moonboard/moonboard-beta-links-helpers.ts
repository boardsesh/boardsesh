import { betaLinkIdentity, getInstagramMediaId, normalizeBetaVideoUrl } from '@boardsesh/shared-schema';

// =============================================================================
// MoonBoard beta-video links
// =============================================================================
// The MoonBoard app exposes the Instagram clips people have filmed on a
// problem. The capture is one JSON object keyed by problem id, each carrying
// the links the app reports for it.
//
// Everything here is pure so the dedupe rules can be exercised without a
// database. import-moonboard-beta-links.ts keeps the I/O.
// =============================================================================

export type MoonBoardBetaVideoLink = {
  problemId: number;
  videoId: string;
  provider: string;
  url: string;
  /**
   * The MoonBoard CDN's own thumbnail. Captured, deliberately NOT imported:
   * the beta-video resolver discards any thumbnail that is not ours
   * (`isOurS3Url`) and caches its own copy on first render, so persisting a
   * foreign URL buys nothing and just makes the column lie about what we host.
   */
  thumbnail?: string | null;
};

export type MoonBoardBetaVideoFile = {
  schemaVersion: number;
  problems: Record<string, { betaVideos: number; links: MoonBoardBetaVideoLink[] }>;
};

export type StagedBetaLink = {
  problemId: number;
  climbUuid: string;
  link: string;
  shortcode: string;
  videoIdentity: string;
};

export type BetaLinkStagingCounters = {
  /** Links present in the capture, before any filtering. */
  sourceLinks: number;
  /** Rejected: not a URL shape we accept (`INSTAGRAM_URL_REGEX`). */
  rejectedUrl: number;
  /** Skipped: the problem id resolves to no climb we hold. */
  unresolvedProblem: number;
  /** Skipped: another problem in this capture already claimed the video. */
  duplicateInFile: number;
  /** Skipped: the video is already attached to a climb in the database. */
  alreadyPresent: number;
  /** Rows staged for insert. */
  staged: number;
};

export type BetaLinkStaging = {
  rows: StagedBetaLink[];
  counters: BetaLinkStagingCounters;
  /** Problem ids we could not resolve to a climb, capped for the run log. */
  unresolvedProblemIds: number[];
  /** Videos two problems both claim, capped for the run log. */
  contestedVideoIds: { videoIdentity: string; keptProblemId: number; droppedProblemId: number }[];
};

const SAMPLE_LIMIT = 10;

export type StageBetaLinksArgs = {
  file: MoonBoardBetaVideoFile;
  /** MoonBoard problem id → the canonical climb uuid it resolves to today. */
  canonicalUuidByProblemId: ReadonlyMap<number, string>;
  /** Every `video_identity` already in `board_beta_links`, any board. */
  existingVideoIdentities: ReadonlySet<string>;
};

/**
 * Map the capture into `board_beta_links` rows, applying the three dedupe rules
 * that `board_beta_links_video_identity_unique` forces on us.
 *
 * That index is **global**, not per-climb: one video attaches to exactly one
 * climb across the whole table. So a video cannot simply be inserted for every
 * problem that lists it — a contested video has to be awarded to one problem,
 * and a video a Boardsesh user already attached has to be left where it is.
 *
 * Problems are processed in ascending id order so the award is deterministic:
 * re-running the import yields the same rows rather than shuffling a video
 * between two problems depending on object key order.
 *
 * Resolution is checked BEFORE a problem claims a video. Otherwise an
 * unresolvable problem with the lower id would consume the identity and the
 * resolvable one would silently lose its beta.
 */
export function stageBetaLinks(args: StageBetaLinksArgs): BetaLinkStaging {
  const { file, canonicalUuidByProblemId, existingVideoIdentities } = args;

  const rows: StagedBetaLink[] = [];
  const counters: BetaLinkStagingCounters = {
    sourceLinks: 0,
    rejectedUrl: 0,
    unresolvedProblem: 0,
    duplicateInFile: 0,
    alreadyPresent: 0,
    staged: 0,
  };
  const unresolvedProblemIds: number[] = [];
  const contestedVideoIds: BetaLinkStaging['contestedVideoIds'] = [];
  const claimedBy = new Map<string, number>();

  const problemIds = Object.keys(file.problems)
    .map(Number)
    .filter((problemId) => Number.isInteger(problemId))
    .sort((left, right) => left - right);

  for (const problemId of problemIds) {
    const entry = file.problems[String(problemId)];
    const links = entry?.links ?? [];
    counters.sourceLinks += links.length;

    const climbUuid = canonicalUuidByProblemId.get(problemId);
    if (climbUuid === undefined) {
      counters.unresolvedProblem += links.length;
      if (unresolvedProblemIds.length < SAMPLE_LIMIT) unresolvedProblemIds.push(problemId);
      continue;
    }

    for (const link of links) {
      const url = normalizeBetaVideoUrl(link.url ?? '');
      const shortcode = getInstagramMediaId(url);
      if (!shortcode) {
        counters.rejectedUrl++;
        continue;
      }

      const videoIdentity = betaLinkIdentity(url);

      const claimant = claimedBy.get(videoIdentity);
      if (claimant !== undefined) {
        counters.duplicateInFile++;
        // Only report a video two DIFFERENT problems claim. The same link
        // repeated inside one problem's list is noise, not a conflict.
        if (claimant !== problemId && contestedVideoIds.length < SAMPLE_LIMIT) {
          contestedVideoIds.push({ videoIdentity, keptProblemId: claimant, droppedProblemId: problemId });
        }
        continue;
      }

      if (existingVideoIdentities.has(videoIdentity)) {
        // Someone already attached this reel — possibly to a different climb,
        // possibly with a tick and a cached thumbnail behind it. Leave it.
        counters.alreadyPresent++;
        claimedBy.set(videoIdentity, problemId);
        continue;
      }

      claimedBy.set(videoIdentity, problemId);
      rows.push({ problemId, climbUuid, link: url, shortcode, videoIdentity });
      counters.staged++;
    }
  }

  return { rows, counters, unresolvedProblemIds, contestedVideoIds };
}
