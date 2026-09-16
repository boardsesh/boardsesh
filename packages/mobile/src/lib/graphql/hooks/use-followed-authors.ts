import { useEffect, useMemo } from 'react';
import { onlineManager, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  GET_FOLLOWED_AUTHORS,
  FOLLOW_SETTER,
  UNFOLLOW_SETTER,
  FOLLOW_USER,
  UNFOLLOW_USER,
} from '@boardsesh/graphql/operations';
import {
  assertLocalUserDataOwner,
  beginImmediateWrite,
  runLocalWriteWithRetry,
  OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import type { FollowedAuthors } from '@boardsesh/shared-schema';
import {
  readAuthorSnapshot,
  saveAuthorSnapshot,
  type AuthorSnapshot,
} from '../../../db/queries/followed-authors-local';
import { useStoredUserId } from '../../../hooks/use-current-user-id';
import { getHttpClient } from '../client';
import { isOfflineEngineEnabled } from '../../offline-engine';

export const AUTHOR_QUERY_KEYS = [
  'followedAuthors',
  'crewFeed',
  'setterStats',
  'searchClimbs',
  'infiniteSearchClimbs',
  'searchClimbsCount',
] as const;
let latestSnapshotRequest = 0;
export function invalidateAuthorQueries(queryClient: QueryClient) {
  for (const key of AUTHOR_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
}

export async function loadFollowedAuthors(userId: string): Promise<FollowedAuthors> {
  const requestVersion = ++latestSnapshotRequest;
  const { getDatabaseHandle } = await import('../../../db');
  const db = isOfflineEngineEnabled() ? getDatabaseHandle() : null;
  const cached = db ? await readAuthorSnapshot(db, userId) : null;
  if (!onlineManager.isOnline()) {
    if (!cached) throw new Error('Followed authors need an online sync');
    return cached.authors;
  }
  const response = await getHttpClient()
    .request<{ followedAuthors: FollowedAuthors }>(GET_FOLLOWED_AUTHORS)
    .catch((error: unknown) => {
      if (cached) return { followedAuthors: cached.authors, offlineFallback: true };
      throw error;
    });
  if ('offlineFallback' in response) return response.followedAuthors;
  if (db) {
    // Check again after the request: sign-out or a local toggle may have raced it.
    const result: { saved: AuthorSnapshot | null } = { saved: null };
    await runLocalWriteWithRetry(() =>
      db.withExclusiveTransactionAsync(async (txn) => {
        await beginImmediateWrite(txn, OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS);
        if ((await assertLocalUserDataOwner(txn, userId)) !== 'ok') return;
        const pending = await txn.getFirstAsync<{ count: number }>(
          "SELECT COUNT(*) AS count FROM pending_mutations WHERE table_name IN ('setter_follows', 'user_follows') AND status = 'pending'",
        );
        const latest = await readAuthorSnapshot(txn, userId);
        if (
          requestVersion !== latestSnapshotRequest ||
          (pending && pending.count > 0) ||
          JSON.stringify(latest) !== JSON.stringify(cached)
        ) {
          result.saved = latest;
          return;
        }
        const snapshot = { authors: response.followedAuthors, incompleteUserIds: [] };
        await saveAuthorSnapshot(txn, userId, snapshot);
        result.saved = snapshot;
      }),
    );
    if (result.saved) return result.saved.authors;
  }
  return response.followedAuthors;
}

export function useFollowedAuthors() {
  const queryClient = useQueryClient();
  const { userId } = useStoredUserId(true);
  const query = useQuery({
    queryKey: ['followedAuthors', userId],
    queryFn: () => loadFollowedAuthors(userId!),
    enabled: !!userId,
    networkMode: 'always',
    staleTime: 60_000,
  });
  const setterNames = useMemo(() => new Set(query.data?.setterUsernames), [query.data]);
  useEffect(() => {
    if (!query.data) return;
    for (const key of AUTHOR_QUERY_KEYS) {
      if (key !== 'followedAuthors') void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [query.data, queryClient]);
  const userIds = useMemo(() => new Set(query.data?.users.map((user) => user.userId)), [query.data]);
  return { ...query, setterNames, userIds };
}

export function useToggleAuthorFollow() {
  const queryClient = useQueryClient();
  const { userId } = useStoredUserId(true);
  return useMutation({
    networkMode: 'always',
    mutationFn: async ({
      kind,
      identifier,
      follow,
    }: {
      kind: 'setter' | 'user';
      identifier: string;
      follow: boolean;
    }) => {
      if (!userId) throw new Error('Sign in to follow setters');
      const { getDatabaseHandle } = await import('../../../db');
      const db = isOfflineEngineEnabled() ? getDatabaseHandle() : null;
      if (db && (await assertLocalUserDataOwner(db, userId)) === 'ok') {
        const { writeAuthorFollowLocal } = await import('../../../hooks/use-offline-mutations');
        await writeAuthorFollowLocal(db, userId, kind, identifier, follow);
        const snapshot = await readAuthorSnapshot(db, userId);
        if (snapshot) queryClient.setQueryData(['followedAuthors', userId], snapshot.authors);
        const graphqlFetch: GraphQLFetch = (document, variables) => getHttpClient().request(document, variables);
        const { drainMutationQueue } = await import('../../../offline/offline-sync-adapter');
        void drainMutationQueue(db, queryClient, graphqlFetch).catch(() => undefined);
        return { queued: true, viewerId: userId };
      } else {
        const document =
          kind === 'setter' ? (follow ? FOLLOW_SETTER : UNFOLLOW_SETTER) : follow ? FOLLOW_USER : UNFOLLOW_USER;
        await getHttpClient().request(document, {
          input: kind === 'setter' ? { setterUsername: identifier } : { userId: identifier },
        });
        return { queued: false, viewerId: userId };
      }
    },
    onSuccess: ({ queued }) => {
      invalidateAuthorQueries(queryClient);
      if (queued) return; // The drainer invalidates server-backed social state after delivery.
      for (const key of ['publicProfile', 'followers', 'following', 'searchUsers'])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}
