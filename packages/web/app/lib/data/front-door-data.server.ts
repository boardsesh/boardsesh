import 'server-only';
import * as Sentry from '@sentry/nextjs';
import type { SimilarClimb, PublicClimbRelatedContentInput } from '@boardsesh/shared-schema';
import {
  PUBLIC_CLIMB_RELATED_CONTENT,
  type PublicClimbRelatedContentQueryResponse,
  type PublicClimbRelatedContentQueryVariables,
} from '@boardsesh/graphql/operations/public-climb-related-content';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';
import { compactErrorMessage } from '@/app/lib/observability/compact-error';
import { dedupeBetaLinks, mapBetaLinksResponse, type BetaLink } from '@/app/lib/beta-video-url';
import type { BoardName } from '@/app/lib/types';

export type FrontDoorSection<Item> = { status: 'loaded'; items: Item[]; hasMore?: boolean } | { status: 'unavailable' };

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

type FrontDoorSectionName = 'similar-climbs' | 'nearby-climbs' | 'beta-links';
const FRONT_DOOR_REPORT_INTERVAL_MS = 15 * 60_000;
const lastReportedAtMsBySection = new Map<FrontDoorSectionName, number>();

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

export type FrontDoorRelatedContent = {
  similarClimbs: FrontDoorSimilarClimbs;
  betaLinks: FrontDoorSection<BetaLink>;
};

/** Shared backend caches survive web deploys; don't cache visibility snapshots in Next. */
export async function getFrontDoorRelatedContent(
  input: PublicClimbRelatedContentInput & { boardType: BoardName },
): Promise<FrontDoorRelatedContent> {
  try {
    const { publicClimbRelatedContent: content } = await executeGraphQLInternal<
      PublicClimbRelatedContentQueryResponse,
      PublicClimbRelatedContentQueryVariables
    >(PUBLIC_CLIMB_RELATED_CONTENT, { input });

    const sectionError = new Error('Backend section unavailable');
    if (content.similarStatus === 'unavailable') reportFrontDoorOutage('similar-climbs', input, sectionError);
    if (content.nearbyStatus === 'unavailable') reportFrontDoorOutage('nearby-climbs', input, sectionError);
    if (content.betaStatus === 'unavailable') reportFrontDoorOutage('beta-links', input, sectionError);
    const nearby =
      content.nearbyStatus == null
        ? undefined
        : {
            grade: content.nearbyGrade ?? '',
            ...(content.nearbyStatus === 'loaded'
              ? { status: 'loaded' as const, items: content.nearbyClimbs }
              : { status: 'unavailable' as const }),
          };
    return {
      similarClimbs:
        content.similarStatus === 'loaded'
          ? { status: 'loaded', items: content.similarClimbs, ...(nearby && { nearby }) }
          : { status: 'unavailable' },
      betaLinks:
        content.betaStatus === 'loaded'
          ? {
              status: 'loaded',
              items: dedupeBetaLinks(mapBetaLinksResponse(content.betaLinks)),
              hasMore: content.betaHasMore,
            }
          : { status: 'unavailable' },
    };
  } catch (error) {
    reportFrontDoorOutage('similar-climbs', input, error);
    reportFrontDoorOutage('beta-links', input, error);
    return { similarClimbs: { status: 'unavailable' }, betaLinks: { status: 'unavailable' } };
  }
}
