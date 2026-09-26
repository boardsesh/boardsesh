import 'server-only';

import * as Sentry from '@sentry/nextjs';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import { SIMILAR_CLIMBS_QUERY, type SimilarClimbsResponse } from '@boardsesh/graphql/operations/new-climb-feed';
import { GET_BETA_LINKS, type GetBetaLinksQueryResponse } from '@boardsesh/graphql/operations/beta-links';
import { createCachedGraphQLQuery } from '@/app/lib/graphql/server-cached-client';
import { compactErrorMessage } from '@/app/lib/observability/compact-error';
import { dedupeBetaLinks, mapBetaLinksResponse, type BetaLink } from '@/app/lib/beta-video-url';
import type { BoardName } from '@/app/lib/types';

/**
 * Server-side reads for the climb front door's two GraphQL-backed sections.
 *
 * Both are cached, and the cache on `similarClimbs` is load-bearing rather than
 * an optimisation. The resolver is rate-limited 30 requests/minute per IP
 * (`packages/backend/src/graphql/resolvers/climbs/queries.ts`), and a
 * server-side call presents ONE IP — the web server's — for the whole world's
 * traffic. Its CTE also scans `board_climb_holds` across the entire layout. A
 * crawler walking a few hundred thousand climb pages is precisely the workload
 * that saturates both.
 *
 * Since #4968 it is no longer the ONLY cache on that path. `unstable_cache` is
 * per web instance and starts empty on every build, so a second one lives
 * behind the resolver in Redis
 * (`packages/backend/src/graphql/resolvers/climbs/similar-climbs-cache.ts`),
 * shared across instances and surviving a web deploy. This one still earns its
 * keep: it saves the round trip entirely.
 *
 * Both helpers swallow their errors. A 429 or a backend blip must degrade the
 * section, never 500 an indexed page.
 *
 * What they must NOT do is degrade to `[]`. See {@link FrontDoorSection}.
 */

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

const SIMILAR_CLIMBS_REVALIDATE_SECONDS = 3600;
const BETA_LINKS_REVALIDATE_SECONDS = 3600;
/**
 * Wall-clock ceiling on each backend round trip. Both callers already degrade to
 * an honest "didn't load" state, so this turns "the page hangs behind a wedged
 * backend" into "the page renders and says so". Shorter than the DB read
 * deadline: these two sections are supplementary, the climb itself is not.
 *
 * **Deliberately not raised, and deliberately not retried.** Both would trade
 * the reader's time for a section they can live without, and both push MORE
 * work at the backend that just failed to answer in three seconds — a second
 * attempt from the same wedged pool is the load that made the first one slow.
 * The similar-climbs section retries instead from the reader's own browser
 * (`SimilarClimbsList` re-runs the query on hydration when the server hands it
 * no seed), which costs the crawler nothing, spends nobody's server-render
 * budget, and bills the resolver's 30/min rate limit against the reader's IP
 * rather than the web server's single shared one.
 */
const FRONT_DOOR_BACKEND_TIMEOUT_MS = 3000;

type FrontDoorSectionName = 'similar-climbs' | 'beta-links';

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
 * now happens on a stable `errorClass`, and the retry-after text is dropped
 * entirely rather than just moved to `extra`, so it can never resurrect the
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
  if (/AbortError|aborted/i.test(compactError)) {
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

export async function getFrontDoorSimilarClimbs(params: {
  boardType: BoardName;
  layoutId: number;
  climbUuid: string;
  angle: number;
  threshold?: number;
  limit?: number;
}): Promise<FrontDoorSection<SimilarClimb>> {
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
    return { status: 'loaded', items: response.similarClimbs ?? [] };
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
