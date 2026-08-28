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
 * Both helpers swallow their errors and return an empty list. A 429 or a
 * backend blip must degrade the section, never 500 an indexed page.
 */

const SIMILAR_CLIMBS_REVALIDATE_SECONDS = 3600;
const BETA_LINKS_REVALIDATE_SECONDS = 3600;
/**
 * Wall-clock ceiling on each backend round trip. Both callers already degrade to
 * an empty section, so this turns "the page hangs behind a wedged backend" into
 * "the page renders without that section". Shorter than the DB read deadline:
 * these two sections are supplementary, the climb itself is not.
 */
const FRONT_DOOR_BACKEND_TIMEOUT_MS = 3000;

// Once per section per OUTAGE, not per render. A backend wedge fails every
// climb-view render for as long as it lasts, so one log line says the same
// thing as ten thousand — but latching it for the process lifetime would turn
// a broken -> recovered -> broken cycle into a silent second outage. A
// successful render re-arms the key, so each distinct outage costs exactly
// one console.error + one Sentry message.
const reportedFrontDoorFailures = new Set<string>();

function reportFrontDoorOutage(
  section: 'similar-climbs' | 'beta-links',
  params: { boardType: BoardName; climbUuid: string },
  error: unknown,
): void {
  if (reportedFrontDoorFailures.has(section)) {
    return;
  }
  reportedFrontDoorFailures.add(section);

  const compactError = compactErrorMessage(error);
  console.error(`Front door: ${section} unavailable, rendering the section empty`, {
    boardType: params.boardType,
    climbUuid: params.climbUuid,
    error: compactError,
  });
  Sentry.captureMessage(`Front door ${section} unavailable: ${compactError}`, 'warning');
}

function reportFrontDoorRecovered(section: 'similar-climbs' | 'beta-links'): void {
  reportedFrontDoorFailures.delete(section);
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
}): Promise<SimilarClimb[]> {
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
    reportFrontDoorRecovered('similar-climbs');
    return response.similarClimbs ?? [];
  } catch (error) {
    reportFrontDoorOutage('similar-climbs', params, error);
    return [];
  }
}

export async function getFrontDoorBetaLinks(params: { boardType: BoardName; climbUuid: string }): Promise<BetaLink[]> {
  const query = createCachedGraphQLQuery<GetBetaLinksQueryResponse, { boardType: string; climbUuid: string }>(
    GET_BETA_LINKS,
    `beta-links-${params.climbUuid}`,
    BETA_LINKS_REVALIDATE_SECONDS,
    FRONT_DOOR_BACKEND_TIMEOUT_MS,
  );

  try {
    const response = await query({ boardType: params.boardType, climbUuid: params.climbUuid });
    reportFrontDoorRecovered('beta-links');
    return dedupeBetaLinks(mapBetaLinksResponse(response.betaLinks ?? []));
  } catch (error) {
    reportFrontDoorOutage('beta-links', params, error);
    return [];
  }
}
