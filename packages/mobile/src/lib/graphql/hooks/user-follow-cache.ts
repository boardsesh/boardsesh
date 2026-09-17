import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { FollowConnection, PublicUserProfile, UserSearchConnection } from '@boardsesh/shared-schema';

/** Commit local follow state to existing screens while the outbox waits for signal. */
export function updateUserFollowCaches(
  queryClient: QueryClient,
  targetUserId: string,
  follow: boolean,
  viewerId: string,
) {
  const ownFollowing = queryClient.getQueryData<InfiniteData<FollowConnection>>(['following', viewerId]);
  const cachedTarget =
    queryClient.getQueryData<PublicUserProfile>(['publicProfile', targetUserId]) ??
    ownFollowing?.pages.flatMap((page) => page.users).find((person) => person.id === targetUserId) ??
    queryClient
      .getQueriesData<InfiniteData<UserSearchConnection>>({ queryKey: ['searchUsers'] })
      .flatMap(([, search]) => search?.pages.flatMap((page) => page.results.map((result) => result.user)) ?? [])
      .find((person) => person.id === targetUserId);
  const wasFollowed =
    cachedTarget?.isFollowedByMe ??
    (ownFollowing
      ? ownFollowing.pages.some((page) => page.users.some((person) => person.id === targetUserId))
      : !follow);
  const countDelta = wasFollowed === follow ? 0 : follow ? 1 : -1;
  const updatePerson = (person: PublicUserProfile): PublicUserProfile => {
    if (person.id === viewerId) return { ...person, followingCount: Math.max(0, person.followingCount + countDelta) };
    if (person.id !== targetUserId || person.isFollowedByMe === follow) return person;
    return { ...person, isFollowedByMe: follow, followerCount: Math.max(0, person.followerCount + (follow ? 1 : -1)) };
  };
  queryClient.setQueriesData<PublicUserProfile>({ queryKey: ['publicProfile'] }, (profile) =>
    profile ? updatePerson(profile) : profile,
  );
  for (const key of ['followers', 'following']) {
    queryClient.setQueriesData<InfiniteData<FollowConnection>>({ queryKey: [key] }, (connections) =>
      connections
        ? {
            ...connections,
            pages: connections.pages.map((page) => ({ ...page, users: page.users.map(updatePerson) })),
          }
        : connections,
    );
  }
  // Only the viewer's own Following connection changes membership. Other
  // people's lists retain their membership and only update follow-button state.
  queryClient.setQueryData<InfiniteData<FollowConnection>>(['following', viewerId], (connections) => {
    if (!connections) return connections;
    const alreadyListed = connections.pages.some((page) => page.users.some((person) => person.id === targetUserId));
    return {
      ...connections,
      pages: connections.pages.map((page, index) => ({
        ...page,
        totalCount: Math.max(0, page.totalCount + countDelta),
        users: follow
          ? index === 0 && !alreadyListed && cachedTarget
            ? [updatePerson(cachedTarget), ...page.users]
            : page.users
          : page.users.filter((person) => person.id !== targetUserId),
      })),
    };
  });
  queryClient.setQueriesData<InfiniteData<UserSearchConnection>>({ queryKey: ['searchUsers'] }, (search) =>
    search
      ? {
          ...search,
          pages: search.pages.map((page) => ({
            ...page,
            results: page.results.map((result) => ({ ...result, user: updatePerson(result.user) })),
          })),
        }
      : search,
  );
}
