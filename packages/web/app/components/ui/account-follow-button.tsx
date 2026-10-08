'use client';

import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import MuiButton from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import {
  GET_PRIVACY_SETTINGS,
  type PrivacySettings,
  GET_PRIVACY_RELATIONSHIP,
  REQUEST_FOLLOW,
  CANCEL_FOLLOW_REQUEST,
  type PrivacyRelationship,
} from '@boardsesh/graphql/operations/privacy';
import { UNFOLLOW_USER } from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { revokeWebPrivacySnapshots } from '@/app/lib/privacy-client';

export function AccountFollowButton({
  userId,
  onFollowChange,
  fallback,
}: {
  userId: string;
  onFollowChange?: (following: boolean) => void;
  fallback: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { data: session } = useSession();
  const { token, isAuthenticated } = useWsAuthToken();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['sitePrivacySettings', session?.user?.id],
    queryFn: async ({ signal }) =>
      (
        await createGraphQLHttpClient(token).request<{ privacySettings: PrivacySettings }>({
          document: GET_PRIVACY_SETTINGS,
          signal,
        })
      ).privacySettings,
    enabled: !!token && isAuthenticated,
    retry: false,
  });
  const relationship = useQuery({
    queryKey: ['privacyRelationship', session?.user?.id, userId],
    queryFn: async ({ signal }) =>
      (
        await createGraphQLHttpClient(token).request<{ privacyRelationship: PrivacyRelationship }>({
          document: GET_PRIVACY_RELATIONSHIP,
          variables: { userId },
          signal,
        })
      ).privacyRelationship,
    enabled: !!token && isAuthenticated && !!settings.data,
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: async () => {
      const current = relationship.data;
      if (!current || !token) throw new Error('Follow state is not available');
      const client = createGraphQLHttpClient(token);
      if (current.requestPending) {
        await client.request(CANCEL_FOLLOW_REQUEST, { userId });
        return false;
      }
      if (current.isFollowing) {
        await client.request(UNFOLLOW_USER, { input: { userId } });
        return false;
      }
      const response = await client.request<{ requestFollow: PrivacyRelationship }>(REQUEST_FOLLOW, { userId });
      return response.requestFollow.isFollowing;
    },
    onSuccess: async (isFollowing) => {
      if (isFollowing !== relationship.data?.isFollowing) onFollowChange?.(isFollowing);
      await revokeWebPrivacySnapshots(queryClient);
    },
  });
  if (!isAuthenticated) return null;
  const current = relationship.data;
  if (
    settings.isError ||
    (settings.data?.enabled === false && current && !current.isPrivate && !current.requestPending)
  )
    return fallback;
  const label = current?.requestPending
    ? t('privacy.cancelRequest')
    : current?.isFollowing
      ? tCommon('follow.following')
      : current?.isPrivate
        ? t('privacy.requestFollow')
        : tCommon('follow.follow');
  return (
    <Stack spacing={1}>
      <MuiButton
        size="small"
        variant={current?.isFollowing || current?.requestPending ? 'outlined' : 'contained'}
        disabled={!current || toggle.isPending || settings.data?.enabled !== true}
        onClick={() => toggle.mutate()}
      >
        {label}
      </MuiButton>
      {toggle.isError || relationship.isError ? <Alert severity="error">{t('privacy.followFailed')}</Alert> : null}
    </Stack>
  );
}
