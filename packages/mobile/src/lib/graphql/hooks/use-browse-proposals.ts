// The proposal feed's read side: the paginated moderation queue, the per-climb
// pull used to pin a proposal opened from a notification, and the cache shapes
// both write through.
//
// Every cache here keys under `PROPOSALS_QUERY_KEY`, so one `setQueriesData`
// prefix write reaches the browse pages AND the pinned climb query — which is
// what makes a vote cast on a pinned card move the same row in the list behind
// it. `mapCachedProposals` is the shared walker for that; it lives here because
// this file is the one that decides what the cached documents look like.

import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import {
  BROWSE_PROPOSALS,
  GET_CLIMB_PROPOSALS,
  type BrowseProposalsResponse,
  type BrowseProposalsVariables,
  type GetClimbProposalsResponse,
  type GetClimbProposalsVariables,
} from '@boardsesh/graphql/operations/proposals';
import type { Proposal, ProposalConnection, ProposalStatus } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { PROPOSALS_QUERY_KEY } from './use-report-climb';

/** Proposals per page. Matches the notifications feed's page size. */
export const PROPOSALS_PAGE_SIZE = 20;

/** Proposals move when people vote, so they go stale faster than a profile. */
const PROPOSALS_STALE_TIME_MS = 60 * 1000;

/** The board / status filters the moderation feed's header offers. */
export type BrowseProposalsFilters = {
  /** A board type to scope to, or `null` for every board. */
  boardType: string | null;
  /** A status to scope to, or `null` for the whole history. */
  status: ProposalStatus | null;
};

/**
 * Query key for one filter combination. The filters ride IN the key rather than
 * being applied client-side: `browseProposals` sorts open proposals first
 * server-side, and re-sorting a filtered subset on the device would fight it.
 */
export function browseProposalsKey(filters: BrowseProposalsFilters) {
  return [...PROPOSALS_QUERY_KEY, 'browse', filters] as const;
}

/** Query key for the proposals on one climb (the pinned deep-link card). */
export function climbProposalsKey(climbUuid: string) {
  return [...PROPOSALS_QUERY_KEY, 'climb', climbUuid] as const;
}

export type UseBrowseProposalsInput = BrowseProposalsFilters & {
  /**
   * `false` stops the request before it leaves the device. The kill switch uses
   * it: with the flag flipped the feed must not even ask, so a takedown is a
   * quiet screen rather than a queue nobody is allowed to act on. Kept OUT of
   * `browseProposalsKey` — it gates fetching, it doesn't name a different list.
   */
  enabled?: boolean;
};

/**
 * The moderation queue: every open report and proposal, newest board activity
 * first. Deliberately NOT gated on auth — a signed-out climber can read what the
 * crew is deciding; only the vote and resolve buttons need an account.
 */
export function useBrowseProposals({ boardType, status, enabled = true }: UseBrowseProposalsInput) {
  return useInfiniteQuery({
    queryKey: browseProposalsKey({ boardType, status }),
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      // Null filters are omitted rather than sent as null: the resolver treats a
      // present key as a filter, so `{ boardType: null }` and "no boardType key"
      // are not the same request on every backend version.
      const variables: BrowseProposalsVariables = {
        input: {
          limit: PROPOSALS_PAGE_SIZE,
          offset: Number(pageParam),
          ...(boardType ? { boardType } : {}),
          ...(status ? { status } : {}),
        },
      };
      return getHttpClient().request<BrowseProposalsResponse, BrowseProposalsVariables>(BROWSE_PROPOSALS, variables);
    },
    // Offset = proposals ALREADY HELD, not pages × page size. The resolver
    // derives `hasMore` from `offset + proposals.length < totalCount`, so a
    // short page (the last one, or one thinned by a permission filter) would
    // otherwise skip rows.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.browseProposals.hasMore
        ? allPages.reduce((total, page) => total + page.browseProposals.proposals.length, 0)
        : undefined,
    staleTime: PROPOSALS_STALE_TIME_MS,
  });
}

export type UseClimbProposalsPinnedInput = {
  climbUuid: string | null | undefined;
  boardType: string | null | undefined;
  enabled: boolean;
};

/**
 * The proposals on one climb, for the card pinned above the feed when a
 * notification names a proposal that hasn't turned up in the loaded pages yet.
 * One page is enough — a climb with 20+ open proposals is not a case worth
 * paginating for.
 */
export function useClimbProposalsPinned({ climbUuid, boardType, enabled }: UseClimbProposalsPinnedInput) {
  return useQuery({
    queryKey: climbProposalsKey(climbUuid ?? ''),
    queryFn: async () => {
      // Unreachable while `enabled` holds, but the compiler can't see that and a
      // silent request with an empty uuid would 400 in a way nobody could read.
      if (!climbUuid || !boardType) throw new Error('climbProposals needs a climb uuid and board type');
      const variables: GetClimbProposalsVariables = {
        input: { climbUuid, boardType, limit: PROPOSALS_PAGE_SIZE },
      };
      return getHttpClient().request<GetClimbProposalsResponse, GetClimbProposalsVariables>(
        GET_CLIMB_PROPOSALS,
        variables,
      );
    },
    enabled: enabled && !!climbUuid && !!boardType,
    staleTime: PROPOSALS_STALE_TIME_MS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProposalConnection(value: unknown): value is ProposalConnection {
  return isRecord(value) && Array.isArray(value.proposals);
}

/**
 * Rewrite every proposal in one cached document, whatever shape it has.
 *
 * Three shapes live under `PROPOSALS_QUERY_KEY`: the infinite-query envelope
 * (`{ pages, pageParams }`), a browse page (`{ browseProposals }`), and the
 * pinned climb query (`{ climbProposals }`). Walking them structurally rather
 * than per-hook is what lets a single vote write land in all of them without the
 * mutation knowing which screens happen to be mounted.
 *
 * Anything unrecognised is returned untouched, so an unrelated cache that
 * happens to sit under the prefix is never mangled.
 */
export function mapCachedProposals(cached: unknown, mapProposal: (proposal: Proposal) => Proposal): unknown {
  if (!isRecord(cached)) return cached;

  const { pages } = cached;
  if (Array.isArray(pages)) {
    const nextPages: unknown[] = pages.map((page: unknown) => mapCachedProposals(page, mapProposal));
    return { ...cached, pages: nextPages };
  }

  const { browseProposals } = cached;
  if (isProposalConnection(browseProposals)) {
    return {
      ...cached,
      browseProposals: { ...browseProposals, proposals: browseProposals.proposals.map(mapProposal) },
    };
  }

  const { climbProposals } = cached;
  if (isProposalConnection(climbProposals)) {
    return {
      ...cached,
      climbProposals: { ...climbProposals, proposals: climbProposals.proposals.map(mapProposal) },
    };
  }

  return cached;
}

/** Apply `mapProposal` to every proposal in every cache under the prefix. */
export function mapProposalCaches(queryClient: QueryClient, mapProposal: (proposal: Proposal) => Proposal): void {
  queryClient.setQueriesData<unknown>({ queryKey: PROPOSALS_QUERY_KEY }, (cached: unknown) =>
    mapCachedProposals(cached, mapProposal),
  );
}

/** Replace one proposal, by uuid, everywhere it is cached. */
export function writeProposalToCaches(queryClient: QueryClient, proposal: Proposal): void {
  mapProposalCaches(queryClient, (cached) => (cached.uuid === proposal.uuid ? proposal : cached));
}
