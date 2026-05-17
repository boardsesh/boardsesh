'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import MuiTypography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Rating from '@mui/material/Rating';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import { EmptyState } from '@/app/components/ui/empty-state';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ElectricBoltOutlined from '@mui/icons-material/ElectricBoltOutlined';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import { useInfiniteQuery } from '@tanstack/react-query';
import { persistUser } from '@/app/lib/react-query-persist-meta';
import type { TFunction } from 'i18next';
import { formatTickRelativeTime, tickTimeMs } from '@/app/lib/format-tick-time';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_GROUPED_ASCENTS_FEED,
  type GroupedAscentFeedItem,
  type AscentFeedItem,
  type GetUserGroupedAscentsFeedQueryVariables,
  type GetUserGroupedAscentsFeedQueryResponse,
} from '@/app/lib/graphql/operations';
import AscentThumbnail from './ascent-thumbnail';
import ClimbIcons from '@/app/components/climb-card/climb-icons';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import { useDeleteTick } from '@/app/hooks/use-delete-tick';
import { themeTokens } from '@/app/theme/theme-config';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import styles from './ascents-feed.module.css';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';

type AscentsFeedProps = {
  userId: string;
  pageSize?: number;
  isOwnProfile?: boolean;
};

// Layout name mapping
const layoutNames: Record<string, string> = {
  'kilter-1': 'Kilter Original',
  'kilter-8': 'Kilter Homewall',
  'tension-9': 'Tension Classic',
  'tension-10': 'Tension 2 Mirror',
  'tension-11': 'Tension 2 Spray',
  'moonboard-1': 'MoonBoard 2010',
  'moonboard-2': 'MoonBoard 2016',
  'moonboard-3': 'MoonBoard 2024',
  'moonboard-4': 'MoonBoard Masters 2017',
  'moonboard-5': 'MoonBoard Masters 2019',
};

const getLayoutDisplayName = (boardType: string, layoutId: number | null): string => {
  if (layoutId === null) return formatBoardDisplayName(boardType);
  const key = `${boardType}-${layoutId}`;
  return layoutNames[key] || formatBoardDisplayName(boardType);
};

const getGroupStatusSummary = (
  group: GroupedAscentFeedItem,
  t: TFunction,
): { text: string; icon: React.ReactNode; color: string } => {
  const parts: string[] = [];

  if (group.flashCount > 0) {
    parts.push(t('ascents.flashed', { count: group.flashCount }));
  }
  if (group.sendCount > 0) {
    parts.push(t('ascents.sent', { count: group.sendCount }));
  }
  if (group.attemptCount > 0) {
    parts.push(t('ascents.attempts', { count: group.attemptCount }));
  }

  let icon: React.ReactNode;
  let color: string;
  if (group.flashCount > 0) {
    icon = <ElectricBoltOutlined />;
    color = 'gold';
  } else if (group.sendCount > 0) {
    icon = <CheckCircleOutlined />;
    color = 'green';
  } else {
    icon = <PersonFallingIcon />;
    color = 'default';
  }

  return { text: parts.join(', '), icon, color };
};

const getItemStatusColor = (status: string): 'success' | 'primary' | 'default' => {
  if (status === 'flash') return 'success';
  if (status === 'send') return 'primary';
  return 'default';
};

const getItemStatusLabel = (status: string, t: TFunction): string => {
  if (status === 'flash') return t('ascents.statusFlash');
  if (status === 'send') return t('ascents.statusSend');
  if (status === 'attempt') return t('ascents.statusAttempt');
  return status;
};

const TickItemRow: React.FC<{
  item: AscentFeedItem;
  onDelete: (uuid: string) => void;
  isDeleting: boolean;
}> = ({ item, onDelete, isDeleting }) => {
  const { t } = useTranslation('common');
  const timeAgo = formatTickRelativeTime(item.climbedAt);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
      <Chip
        label={getItemStatusLabel(item.status, t)}
        size="small"
        color={getItemStatusColor(item.status)}
        variant={item.status === 'attempt' ? 'outlined' : 'filled'}
        sx={{
          height: 20,
          '& .MuiChip-label': { px: 0.75, fontSize: themeTokens.typography.fontSize.xs - 1 },
        }}
      />
      <MuiTypography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
        {item.attemptCount > 1 ? t('ascents.attempts', { count: item.attemptCount }) : null} {timeAgo}
      </MuiTypography>
      <ConfirmPopover
        title={t('ascents.deleteTitle')}
        description={t('ascents.deleteDescription')}
        onConfirm={() => onDelete(item.uuid)}
        okText={t('actions.delete')}
        cancelText={t('actions.cancel')}
        okButtonProps={{ color: 'error' }}
      >
        <IconButton size="small" disabled={isDeleting} sx={{ color: 'text.secondary' }}>
          <DeleteOutlined sx={{ fontSize: 16 }} />
        </IconButton>
      </ConfirmPopover>
    </Box>
  );
};

const GroupedFeedItem: React.FC<{
  group: GroupedAscentFeedItem;
  isOwnProfile?: boolean;
  onDeleteTick?: (uuid: string) => void;
  isDeleting?: boolean;
}> = ({ group, isOwnProfile = false, onDeleteTick, isDeleting = false }) => {
  const { t } = useTranslation('common');
  const latestItem = group.items.reduce((latest, item) =>
    tickTimeMs(item.climbedAt) > tickTimeMs(latest.climbedAt) ? item : latest,
  );
  const timeAgo = formatTickRelativeTime(latestItem.climbedAt);
  const boardDisplay = getLayoutDisplayName(group.boardType, group.layoutId);
  const statusSummary = getGroupStatusSummary(group, t);
  const hasSuccess = group.flashCount > 0 || group.sendCount > 0;

  return (
    <MuiCard className={styles.feedItem}>
      <CardContent sx={{ p: 1.5 }}>
        <Box sx={{ display: 'flex', gap: '12px' }}>
          {group.frames && group.layoutId && (
            <AscentThumbnail
              boardType={group.boardType}
              layoutId={group.layoutId}
              angle={group.angle}
              climbUuid={group.climbUuid}
              climbName={group.climbName}
              frames={group.frames}
              isMirror={group.isMirror}
            />
          )}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }} className={styles.feedItemContent}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Chip
                  icon={statusSummary.icon as React.ReactElement}
                  label={statusSummary.text}
                  size="small"
                  color={statusSummary.color === 'green' ? 'success' : undefined}
                  sx={
                    statusSummary.color === 'gold'
                      ? { bgcolor: themeTokens.colors.amber, color: 'var(--neutral-900)' }
                      : undefined
                  }
                  className={styles.statusTag}
                />
                <MuiTypography variant="body2" component="span" fontWeight={600} className={styles.climbName}>
                  {group.climbName}
                  <ClimbIcons isNoMatch={!!group.isNoMatch} isBenchmark={!!group.isBenchmark} />
                </MuiTypography>
              </Box>
              <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.timeAgo}>
                {timeAgo}
              </MuiTypography>
            </Box>

            <Box sx={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {group.difficultyName && <Chip label={group.difficultyName} size="small" color="primary" />}
              <Chip icon={<LocationOnOutlined />} label={`${group.angle}°`} size="small" />
              <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.boardType}>
                {boardDisplay}
              </MuiTypography>
              {group.isMirror && <Chip label={t('ascentsFeed.mirrored')} size="small" color="secondary" />}
              {group.isBenchmark && <Chip label={t('ascentsFeed.benchmark')} size="small" />}
            </Box>

            {hasSuccess && group.bestQuality && (
              <Rating readOnly value={group.bestQuality} max={5} className={styles.rating} />
            )}

            {group.setterUsername && (
              <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.setter}>
                {t('ascentsFeed.setBy', { name: group.setterUsername })}
              </MuiTypography>
            )}

            {group.latestComment && (
              <MuiTypography variant="body2" component="span" className={styles.comment}>
                {group.latestComment}
              </MuiTypography>
            )}

            {isOwnProfile && onDeleteTick && (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  borderTop: `1px solid ${themeTokens.neutral[100]}`,
                  mt: 0.5,
                  pt: 0.5,
                }}
              >
                {group.items.map((item) => (
                  <TickItemRow key={item.uuid} item={item} onDelete={onDeleteTick} isDeleting={isDeleting} />
                ))}
              </Box>
            )}
          </Box>
        </Box>
      </CardContent>
    </MuiCard>
  );
};

export const AscentsFeed: React.FC<AscentsFeedProps> = ({ userId, pageSize = 10, isOwnProfile = false }) => {
  const { t } = useTranslation('feed');
  const deleteTick = useDeleteTick();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, error } = useInfiniteQuery({
    queryKey: ['ascentsFeed', userId, pageSize],
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(null);
      const variables: GetUserGroupedAscentsFeedQueryVariables = {
        userId,
        input: { limit: pageSize, offset: pageParam },
      };
      const response = await client.request<GetUserGroupedAscentsFeedQueryResponse>(
        GET_USER_GROUPED_ASCENTS_FEED,
        variables,
      );
      return response.userGroupedAscentsFeed;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.groups.length;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    meta: persistUser,
  });

  const groups: GroupedAscentFeedItem[] = useMemo(() => data?.pages.flatMap((p) => p.groups) ?? [], [data]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <CircularProgress />
      </div>
    );
  }

  if (error) {
    return <EmptyState description={t('errors.loadActivity')} />;
  }

  if (groups.length === 0) {
    return <EmptyState description={t('ascentsFeed.empty')} />;
  }

  return (
    <div className={styles.feed}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {groups.map((group) => (
          <GroupedFeedItem
            key={group.key}
            group={group}
            isOwnProfile={isOwnProfile}
            onDeleteTick={isOwnProfile ? (uuid) => deleteTick.mutate(uuid) : undefined}
            isDeleting={deleteTick.isPending}
          />
        ))}
      </Box>

      <Box ref={sentinelRef} sx={{ display: 'flex', justifyContent: 'center', py: 2, minHeight: 20 }}>
        {isFetchingNextPage && <CircularProgress size={24} />}
      </Box>
    </div>
  );
};

export default AscentsFeed;
