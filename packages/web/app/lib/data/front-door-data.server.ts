import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { gql } from 'graphql-request';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { canAddClimbToBoard } from '@boardsesh/board-config';
import type { Climb, SimilarClimb } from '@boardsesh/shared-schema';
import type { ClimbSearchInputVariables } from '@boardsesh/graphql/operations/climb-search';
import { SIMILAR_CLIMBS_QUERY, type SimilarClimbsResponse } from '@boardsesh/graphql/operations/new-climb-feed';
import { GET_BETA_LINKS, type GetBetaLinksQueryResponse } from '@boardsesh/graphql/operations/beta-links';
import { createCachedGraphQLQuery } from '@/app/lib/graphql/server-cached-client';
import { compactErrorMessage } from '@/app/lib/observability/compact-error';
import { dedupeBetaLinks, mapBetaLinksResponse, type BetaLink } from '@/app/lib/beta-video-url';
import type { BoardName } from '@/app/lib/types';

// Cache the anonymous reads across page renders. Crawlers can put hundreds of
// requests per minute through the web server's single backend rate-limit bucket.
// Nearby searches share entries across all climbs in a grade band on one wall.

/**
 * What one supplemental front-door section resolved to.
 *
 * `unavailable` is deliberately not "loaded, with nothing in it", and that
 * distinction is the whole of #4968. Until this type existed both helpers
 * returned a bare array, so a backend deadline and a climb nobody has filmed
 * were the same value — and the page rendered the section's empty copy for
 * both. "No beta filmed yet." and "No similar climbs on this layout." are
 * factual claims about the climb; a 3 s deadline that fired on a cold cache is
 * no evidence for either. Sentry counted 6,922 similar-climbs and 748
 * beta-links renders publishing those claims in 14 days, to readers and to
 * Google, on a search surface whose whole job is being trustworthy.
 *
 * The caller decides what an unavailable section says. It has to say something:
 * an indexable page may not render a section as a blank div or a bare spinner.
 */
export type FrontDoorSection<Item> = { status: 'loaded'; items: Item[] } | { status: 'unavailable' };

export type ClimbPreview = Pick<
  SimilarClimb,
  | 'uuid'
  | 'name'
  | 'setterUsername'
  | 'angle'
  | 'layoutId'
  | 'frames'
  | 'difficultyName'
  | 'qualityAverage'
  | 'ascensionistCount'
  | 'compatibleSizeIds'
>;

export type FrontDoorSimilarClimbs =
  | { status: 'loaded'; items: SimilarClimb[]; nearby?: FrontDoorSection<ClimbPreview> & { grade: string } }
  | { status: 'unavailable' };

const SIMILAR_CLIMBS_REVALIDATE_SECONDS = 3600;
const BETA_LINKS_REVALIDATE_SECONDS = 3600;
const NEARBY_CLIMBS_REVALIDATE_SECONDS = 300;
const NEARBY_CLIMBS_LIMIT = 6;
/**
 * Wall-clock ceiling on each backend round trip. Both callers already degrade to
 * an honest "didn't load" state, so this turns "the page hangs behind a wedged
 * backend" into "the page renders and says so". Shorter than the DB read
 * deadline: these two sections are supplementary, the climb itself is not.
 *
 * **Deliberately not raised, and deliberately not retried.** Both would trade
 * the reader's time for a section they can live without. A nearby-grade read
 * runs only after a successful empty similarity read.
 * The similar-climbs section retries instead from the reader's own browser
 * (`SimilarClimbsList` re-runs the query on hydration when the server hands it
 * no seed), which costs the crawler nothing, spends nobody's server-render
 * budget, and bills the resolver's rate limit against the reader's IP
 * rather than the web server's single shared one.
 */
const FRONT_DOOR_BACKEND_TIMEOUT_MS = 3000;

type FrontDoorSectionName = 'similar-climbs' | 'nearby-climbs' | 'beta-links';

/**
 * At most once per section per 15-minute window, not once per outage.
 *
 * The previous design latched a section the first time it failed and only
 * unlatched it on the next successful render (a `Set`). That made a flapping
 * backend — down, up, down, up — file one Sentry event per flap, because
 * every recovery re-armed the trap: BOARDSESH-FF alone minted 29k events in
 * 12 days this way. A time-based latch reports at most once per section per
 * `FRONT_DOOR_REPORT_INTERVAL_MS`, however many times it flaps in between, and
 * keeps reporting on the same cadence for as long as the outage continues —
 * a wedged backend still gets a heartbeat roughly every 15 minutes instead of
 * going silent forever after the first event.
 *
 * The message and fingerprint are also fixed strings now (see
 * `classifyFrontDoorError` / the `Sentry.withScope` call below) rather
 * than embedding the error text. The old message interpolated the raw error —
 * "Rate limit exceeded. Try again in 29 seconds" — and Sentry groups issues by
 * message, so every distinct retry-after value minted its own issue. Grouping
 * now happens on a stable `errorClass`; the compacted error text survives only
 * as `extra.error`, which Sentry never groups on, so it cannot resurrect the
 * per-value fanout.
 */
const FRONT_DOOR_REPORT_INTERVAL_MS = 15 * 60_000;

const lastReportedAtMsBySection = new Map<FrontDoorSectionName, number>();

/** Test-only: clears the report-interval latch between test cases/files. */
export function __resetFrontDoorReportingForTests(): void {
  lastReportedAtMsBySection.clear();
}

type FrontDoorErrorClass = 'timeout' | 'rate-limited' | 'backend-error';

/**
 * Buckets the compacted error text into a small, stable set of classes used
 * for the Sentry fingerprint. Never put the raw retry-after / abort text back
 * into the message or fingerprint — that is exactly what caused the fanout.
 */
function classifyFrontDoorError(compactError: string): FrontDoorErrorClass {
  // The 3 s deadline aborts via AbortController ("AbortError: This operation
  // was aborted"); the other two spellings cover a transport-level timeout.
  if (/AbortError|aborted|timed out|timeout/i.test(compactError)) {
    return 'timeout';
  }
  if (/Rate limit exceeded/i.test(compactError)) {
    return 'rate-limited';
  }
  return 'backend-error';
}

function reportFrontDoorOutage(
  section: FrontDoorSectionName,
  params: { boardType: BoardName; climbUuid: string },
  error: unknown,
  nowMs: number = Date.now(),
): void {
  // Check-and-set runs synchronously, before any await, so concurrent renders
  // failing in the same tick still produce exactly one report. The log line
  // shares the latch: a wedged backend fails every render, and one line per
  // window says the same thing as one per render at a fraction of the cost.
  const lastReportedAtMs = lastReportedAtMsBySection.get(section);
  if (lastReportedAtMs !== undefined && nowMs - lastReportedAtMs < FRONT_DOOR_REPORT_INTERVAL_MS) {
    return;
  }
  lastReportedAtMsBySection.set(section, nowMs);

  const compactError = compactErrorMessage(error);
  console.error(`Front door: ${section} unavailable, rendering the section's degraded state`, {
    boardType: params.boardType,
    climbUuid: params.climbUuid,
    error: compactError,
  });

  const errorClass = classifyFrontDoorError(compactError);
  Sentry.withScope((scope) => {
    scope.setFingerprint(['front-door-unavailable', section, errorClass]);
    scope.setTag('front_door_section', section);
    scope.setTag('front_door_error_class', errorClass);
    scope.setExtra('error', compactError);
    scope.setExtra('boardType', params.boardType);
    scope.setExtra('climbUuid', params.climbUuid);
    Sentry.captureMessage(`Front door ${section} unavailable`, 'warning');
  });
}

type SimilarClimbsQueryVariables = {
  input: {
    boardType: BoardName;
    layoutId: number;
    climbUuid: string;
    angle: number;
    threshold: number;
    limit: number;
  };
};

type FrontDoorSimilarClimbsParams = {
  boardType: BoardName;
  layoutId: number;
  climbUuid: string;
  angle: number;
  threshold?: number;
  limit?: number;
  fallback?: { sizeId: number; setIds: readonly number[]; difficulty: string };
};

type NearbyClimbRow = Pick<
  Climb,
  | 'uuid'
  | 'name'
  | 'setter_username'
  | 'frames'
  | 'difficulty'
  | 'quality_average'
  | 'ascensionist_count'
  | 'compatibleSizeIds'
>;

const NEARBY_CLIMBS_QUERY = gql`
  query FrontDoorNearbyClimbs($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      climbs {
        uuid
        name
        setter_username
        frames
        difficulty
        quality_average
        ascensionist_count
        compatibleSizeIds
      }
    }
  }
`;

async function getNearbyClimbs({
  boardType,
  layoutId,
  angle,
  climbUuid,
  fallback,
}: FrontDoorSimilarClimbsParams): Promise<(FrontDoorSection<ClimbPreview> & { grade: string }) | undefined> {
  if (!fallback?.setIds.length || !fallback.difficulty || boardType === 'spray') return;

  const { sizeId, setIds, difficulty } = fallback;
  const grades = getBoulderGradesForBoard(boardType);
  const fontGrade = difficulty.split('/')[0].trim().toLowerCase();
  const targetGrade = grades.find(
    (grade) => grade.font_grade === fontGrade || grade.v_grade.toLowerCase() === fontGrade,
  );
  if (!targetGrade) return;

  const grade = targetGrade.difficulty_name;
  const targetV = Number(targetGrade.v_grade.slice(1));
  const gradeBand = grades.filter((grade) => Math.abs(Number(grade.v_grade.slice(1)) - targetV) <= 1);
  const minGrade = gradeBand[0]?.difficulty_id;
  const maxGrade = gradeBand.at(-1)?.difficulty_id;
  if (minGrade == null || maxGrade == null) return;

  const selectedSetIds = [...setIds].sort((first, second) => first - second);
  const pageSize = NEARBY_CLIMBS_LIMIT + 1;
  const deadline = performance.now() + FRONT_DOOR_BACKEND_TIMEOUT_MS;
  const readPage = async (page: number): Promise<NearbyClimbRow[]> => {
    const timeoutMs = Math.ceil(deadline - performance.now());
    if (timeoutMs <= 0) throw new Error('Nearby climb search timed out');

    // Cache by wall and grade band so many climb pages can share a fetch.
    const query = createCachedGraphQLQuery<{ searchClimbs: { climbs: NearbyClimbRow[] } }, ClimbSearchInputVariables>(
      NEARBY_CLIMBS_QUERY,
      'nearby-climbs',
      NEARBY_CLIMBS_REVALIDATE_SECONDS,
      timeoutMs,
    );
    const { searchClimbs } = await query({
      input: {
        boardName: boardType,
        layoutId,
        sizeId,
        setIds: selectedSetIds.join(','),
        angle,
        minGrade,
        maxGrade,
        // One ascent at this angle guarantees the candidate has an actual stats row here.
        minAscents: 1,
        sortBy: 'ascents',
        sortOrder: 'desc',
        page,
        pageSize,
      },
    });
    return searchClimbs.climbs;
  };

  const targetBoard = { board_name: boardType, layout_id: layoutId, size_id: sizeId, set_ids: selectedSetIds };
  const isEligible = (row: NearbyClimbRow) =>
    row.uuid !== climbUuid && Boolean(row.difficulty) && canAddClimbToBoard(row, targetBoard).ok;

  try {
    const firstPage = await readPage(0);
    let eligible = firstPage.filter(isEligible);
    // MoonBoard's catalogue search allows unknown set membership. The frame
    // check can reject a whole page, so sample the next page if it may exist.
    if (eligible.length === 0 && firstPage.length === pageSize) {
      eligible = (await readPage(1)).filter(isEligible);
    }
    const items = eligible.slice(0, NEARBY_CLIMBS_LIMIT).map((row) => ({
      uuid: row.uuid,
      name: row.name,
      setterUsername: row.setter_username,
      frames: row.frames,
      difficultyName: row.difficulty,
      qualityAverage: Number(row.quality_average),
      ascensionistCount: row.ascensionist_count,
      layoutId,
      angle,
      compatibleSizeIds: row.compatibleSizeIds ?? [],
    }));
    return { status: 'loaded', grade, items };
  } catch (error) {
    reportFrontDoorOutage('nearby-climbs', { boardType, climbUuid }, error);
    return { status: 'unavailable', grade };
  }
}

export async function getFrontDoorSimilarClimbs(params: FrontDoorSimilarClimbsParams): Promise<FrontDoorSimilarClimbs> {
  const query = createCachedGraphQLQuery<SimilarClimbsResponse, SimilarClimbsQueryVariables>(
    SIMILAR_CLIMBS_QUERY,
    'similar-climbs',
    SIMILAR_CLIMBS_REVALIDATE_SECONDS,
    FRONT_DOOR_BACKEND_TIMEOUT_MS,
  );

  try {
    const response = await query({
      input: {
        boardType: params.boardType,
        layoutId: params.layoutId,
        climbUuid: params.climbUuid,
        angle: params.angle,
        threshold: params.threshold ?? 0.5,
        limit: params.limit ?? 10,
      },
    });
    const items = response.similarClimbs;
    if (items.length > 0) return { status: 'loaded', items };
    const nearby = await getNearbyClimbs(params);
    return { status: 'loaded', items, ...(nearby && { nearby }) };
  } catch (error) {
    reportFrontDoorOutage('similar-climbs', params, error);
    return { status: 'unavailable' };
  }
}

export async function getFrontDoorBetaLinks(params: {
  boardType: BoardName;
  climbUuid: string;
}): Promise<FrontDoorSection<BetaLink>> {
  const query = createCachedGraphQLQuery<GetBetaLinksQueryResponse, { boardType: string; climbUuid: string }>(
    GET_BETA_LINKS,
    `beta-links-${params.climbUuid}`,
    BETA_LINKS_REVALIDATE_SECONDS,
    FRONT_DOOR_BACKEND_TIMEOUT_MS,
  );

  try {
    const response = await query({ boardType: params.boardType, climbUuid: params.climbUuid });
    return { status: 'loaded', items: dedupeBetaLinks(mapBetaLinksResponse(response.betaLinks ?? [])) };
  } catch (error) {
    reportFrontDoorOutage('beta-links', params, error);
    return { status: 'unavailable' };
  }
}
