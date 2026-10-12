import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_BOARD_SHARE_LINK,
  RESET_BOARD_SHARE_LINK,
  type BoardShareLink,
} from '@boardsesh/graphql/operations/privacy';
import { getHttpClient } from '../client';
import { useProfile } from './index';
import { getConnectivitySnapshot } from '../../connectivity/connectivity-store';

/** Keyed on the signed-in account: another account must never be handed this owner's token. */
export function boardShareLinkQueryKey(profileId: string | undefined, boardUuid: string) {
  return ['boardShareLink', profileId, boardUuid] as const;
}

/**
 * The owner's share link for a Followers or Invite-only home board, minted by
 * the server on first read. `null` when the board has none (Public, Unlisted,
 * Only me). Only fetched while `enabled`, which the share sheet sets while it
 * is open, so browsing boards never mints a link nobody asked for.
 */
export function useBoardShareLink(boardUuid: string, enabled: boolean) {
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: boardShareLinkQueryKey(profile?.id, boardUuid),
    queryFn: async ({ signal }) =>
      (
        await getHttpClient().request<{ boardShareLink: BoardShareLink | null }>({
          document: GET_BOARD_SHARE_LINK,
          variables: { boardUuid },
          signal,
        })
      ).boardShareLink,
    enabled: enabled && !!profile?.id && !!boardUuid,
    // Always asked again when the sheet opens: a reset on another device
    // publishes nothing, and a cached link would hand out a dead one.
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/** Revoke the current link and take the new one. The old link stops working at once. */
export function useResetBoardShareLink(boardUuid: string) {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  return useMutation({
    networkMode: 'always',
    mutationFn: async () => {
      if (getConnectivitySnapshot().effectiveOffline) throw new Error('Resetting a link requires a connection.');
      return (
        await getHttpClient().request<{ resetBoardShareLink: BoardShareLink | null }>(RESET_BOARD_SHARE_LINK, {
          boardUuid,
        })
      ).resetBoardShareLink;
    },
    onSuccess: (link) => {
      queryClient.setQueryData(boardShareLinkQueryKey(profile?.id, boardUuid), link);
    },
  });
}
