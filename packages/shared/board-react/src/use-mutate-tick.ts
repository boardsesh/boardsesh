import { useMutation, useQueryClient, type QueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  UPDATE_TICK,
  DELETE_TICK,
  type AscentFeedItem,
  type UpdateTickInput,
  type UpdateTickVariables,
  type UpdateTickResponse,
  type DeleteTickMutationVariables,
  type DeleteTickMutationResponse,
  type GetUserAscentsFeedQueryResponse,
  type GetUserGroupedAscentsFeedQueryResponse,
} from '@boardsesh/graphql/operations';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { useBoardAdapter } from './adapter';

// Canonical difficulty_id → "6a/V3" display name, the same names the feed
// resolvers serve. UPDATE_TICK returns only the numeric difficulty, so the
// write-through derives the paired name to keep patched items internally
// consistent (grade colors and the day divider's top-grade label read the NAME).
const GRADE_NAME_BY_DIFFICULTY_ID = new Map<number, string>(
  BOULDER_GRADES.map((grade) => [grade.difficulty_id, grade.difficulty_name]),
);

// Stats / feed / climb-state caches that derive from a user's ticks. Editing or
// deleting a tick must refresh all of them. Prefix matching means the bare root
// key invalidates every variant (e.g. ['userTicks', '<any-userId>']).
function invalidateTickDependents(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
  void queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
  void queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });
  void queryClient.invalidateQueries({ queryKey: ['userAscentsFeed'] });
  void queryClient.invalidateQueries({ queryKey: ['userGroupedAscentsFeed'] });
  void queryClient.invalidateQueries({ queryKey: ['logbook'] });
  void queryClient.invalidateQueries({ queryKey: ['climb'] });
  // The mobile climb library reads ['infiniteSearchClimbs'] plus
  // ['searchClimbsCount']; ['searchClimbs'] is the paged web/other-surface
  // variant. Editing or deleting a tick can move the grade a list row shows, so
  // all three have to refetch (issue #4798).
  void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
  void queryClient.invalidateQueries({ queryKey: ['infiniteSearchClimbs'] });
  void queryClient.invalidateQueries({ queryKey: ['searchClimbsCount'] });
  // The Sessions feed and session-detail screens aggregate sends/flashes/grade
  // pyramids straight from these caches; without busting them, editing or
  // deleting a tick leaves those cards showing stale totals until an unrelated
  // refetch (pull-to-refresh, remount past staleTime, or a comment add).
  void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
  void queryClient.invalidateQueries({ queryKey: ['sessionDetail'] });
}

/** Edit an existing tick (status / date / grade / quality / attempts / comment). */
export function useUpdateTick() {
  const { isAuthenticated, executeHttp } = useBoardAdapter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { uuid: string; input: UpdateTickInput }) => {
      if (!isAuthenticated) throw new Error('Not authenticated');
      const response = await executeHttp<UpdateTickResponse, UpdateTickVariables>(UPDATE_TICK, variables);
      return response.updateTick;
    },
    onSuccess: (updatedTick) => {
      // Write-through first so the row is right immediately, then invalidate so
      // the background refetch reconciles anything derived server-side.
      patchTickInAscentFeeds(queryClient, updatedTick);
      invalidateTickDependents(queryClient);
    },
  });
}

/**
 * Write the server's updated tick straight into every cached feed item that
 * carries it. The invalidation that follows refetches the loaded offset pages
 * sequentially — seconds on a deep logbook — and the grouped logbook re-derives
 * best-entry and summed tries from raw items on render, so patching the item
 * fields is enough for an edited row (status flip, tries change) to display
 * correctly before any refetch lands. Not optimistic: this is the server's own
 * response, so there is nothing to roll back.
 */
function patchTickInAscentFeeds(queryClient: QueryClient, updatedTick: UpdateTickResponse['updateTick']) {
  // Concrete AscentFeedItem in/out — both feed caches carry exactly that item
  // type, and a narrower cast here would hide a future shape drift. Only the
  // status needs narrowing: the mutation response types it as plain string
  // while feed items carry the union; the values share one server-side enum.
  const patchItem = (item: AscentFeedItem): AscentFeedItem =>
    item.uuid === updatedTick.uuid
      ? {
          ...item,
          status: updatedTick.status as AscentFeedItem['status'],
          attemptCount: updatedTick.attemptCount,
          quality: updatedTick.quality,
          difficulty: updatedTick.difficulty,
          difficultyName:
            updatedTick.difficulty != null ? (GRADE_NAME_BY_DIFFICULTY_ID.get(updatedTick.difficulty) ?? null) : null,
          isBenchmark: updatedTick.isBenchmark,
          comment: updatedTick.comment,
          climbedAt: updatedTick.climbedAt,
          angle: updatedTick.angle,
        }
      : item;

  queryClient.setQueriesData<InfiniteData<GetUserGroupedAscentsFeedQueryResponse>>(
    { queryKey: ['userGroupedAscentsFeed'] },
    (cached) => {
      if (!cached) return cached;
      return {
        ...cached,
        pages: cached.pages.map((page) => ({
          ...page,
          userGroupedAscentsFeed: {
            ...page.userGroupedAscentsFeed,
            groups: page.userGroupedAscentsFeed.groups.map((group) => ({
              ...group,
              items: group.items.map(patchItem),
            })),
          },
        })),
      };
    },
  );

  queryClient.setQueriesData<InfiniteData<GetUserAscentsFeedQueryResponse>>(
    { queryKey: ['userAscentsFeed'] },
    (cached) => {
      if (!cached) return cached;
      return {
        ...cached,
        pages: cached.pages.map((page) => ({
          ...page,
          userAscentsFeed: {
            ...page.userAscentsFeed,
            items: page.userAscentsFeed.items.map(patchItem),
          },
        })),
      };
    },
  );
}

/**
 * Strip a deleted tick from every cached ascents-feed page by uuid. The
 * invalidation below refetches each loaded 20-item offset page sequentially —
 * seconds on a deep logbook — so without this edit the deleted row would sit
 * visibly in the list until the refetch lands. Lives here (beside the
 * invalidation list) so every delete path — swipe, edit sheet, web — behaves
 * the same and the query-key shape isn't duplicated at call sites.
 */
function stripTickFromAscentFeeds(queryClient: QueryClient, uuid: string) {
  // Grouped variant: remove the tick from its group's items, recompute that
  // group's per-status counts, drop the group when emptied, and decrement the
  // page's totalCount ONLY then (it counts groups). One drop max per delete —
  // duplicate rows across pages are cache artifacts.
  queryClient.setQueriesData<InfiniteData<GetUserGroupedAscentsFeedQueryResponse>>(
    { queryKey: ['userGroupedAscentsFeed'] },
    (cached) => {
      if (!cached) return cached;
      const holdsTick = cached.pages.some((page) =>
        page.userGroupedAscentsFeed.groups.some((group) => group.items.some((item) => item.uuid === uuid)),
      );
      if (!holdsTick) return cached;
      // Decide the drop FIRST: totalCount copies live on every page, and a
      // flag mutated during the map would miss pages processed before the
      // emptied group's page (breaking the lockstep invariant the flat strip
      // documents).
      const groupDropped = cached.pages.some((page) =>
        page.userGroupedAscentsFeed.groups.some((group) => group.items.length === 1 && group.items[0].uuid === uuid),
      );
      return {
        ...cached,
        pages: cached.pages.map((page) => {
          const groups = page.userGroupedAscentsFeed.groups
            .map((group) => {
              if (!group.items.some((item) => item.uuid === uuid)) return group;
              const items = group.items.filter((item) => item.uuid !== uuid);
              if (items.length === 0) {
                return null;
              }
              return {
                ...group,
                items,
                flashCount: items.filter((item) => item.status === 'flash').length,
                sendCount: items.filter((item) => item.status === 'send').length,
                attemptCount: items.filter((item) => item.status === 'attempt').length,
              };
            })
            .filter((group): group is NonNullable<typeof group> => group !== null);
          return {
            ...page,
            userGroupedAscentsFeed: {
              ...page.userGroupedAscentsFeed,
              groups,
              totalCount: groupDropped
                ? Math.max(0, page.userGroupedAscentsFeed.totalCount - 1)
                : page.userGroupedAscentsFeed.totalCount,
            },
          };
        }),
      };
    },
  );

  queryClient.setQueriesData<InfiniteData<GetUserAscentsFeedQueryResponse>>(
    { queryKey: ['userAscentsFeed'] },
    (cached) => {
      if (!cached) return cached;
      // Each page carries a copy of the whole feed's totalCount — keep it
      // consistent with the strip so a surface reading the total isn't
      // stale-high until the background refetch reconciles. One tick = one off
      // the total, even if offset-pagination overlap duplicated its row across
      // cached pages (the duplicates are cache artifacts, not extra ticks).
      // Decrementing EVERY page (not just pages holding the row) is deliberate:
      // the copies must stay in lockstep, and the refetch re-syncs any page
      // whose copy had already drifted.
      const anyRemoved = cached.pages.some((page) => page.userAscentsFeed.items.some((item) => item.uuid === uuid));
      if (!anyRemoved) return cached;
      return {
        ...cached,
        pages: cached.pages.map((page) => ({
          ...page,
          userAscentsFeed: {
            ...page.userAscentsFeed,
            items: page.userAscentsFeed.items.filter((item) => item.uuid !== uuid),
            totalCount: Math.max(0, page.userAscentsFeed.totalCount - 1),
          },
        })),
      };
    },
  );
}

/** Delete a tick by uuid. */
export function useDeleteTick() {
  const { isAuthenticated, executeHttp } = useBoardAdapter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (uuid: string) => {
      if (!isAuthenticated) throw new Error('Not authenticated');
      const response = await executeHttp<DeleteTickMutationResponse, DeleteTickMutationVariables>(DELETE_TICK, {
        uuid,
      });
      return response.deleteTick;
    },
    onSuccess: (_data, uuid) => {
      stripTickFromAscentFeeds(queryClient, uuid);
      invalidateTickDependents(queryClient);
    },
  });
}
