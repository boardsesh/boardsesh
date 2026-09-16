import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { FollowConnection, PublicUserProfile, UserSearchConnection } from '@boardsesh/shared-schema';

/** Commit local follow state to existing screens while the outbox waits for signal. */
export function updateUserFollowCaches(queryClient: QueryClient, targetUserId: string, follow: boolean) {
  const updatePerson = (person: PublicUserProfile): PublicUserProfile => {
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
