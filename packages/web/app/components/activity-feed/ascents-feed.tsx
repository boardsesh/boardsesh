'use client';

import React, { useMemo, useState, useCallback } from 'react';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import MuiTypography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Rating from '@mui/material/Rating';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import { EmptyState } from '@/app/components/ui/empty-state';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ElectricBoltOutlined from '@mui/icons-material/ElectricBoltOutlined';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_GROUPED_ASCENTS_FEED,
  type GroupedAscentFeedItem,
  type AscentFeedItem,
  type GetUserGroupedAscentsFeedQueryVariables,
  type GetUserGroupedAscentsFeedQueryResponse,
} from '@/app/lib/graphql/operations';
import AscentThumbnail from './ascent-thumbnail';
import AscentActionsMenu from '@/app/components/ascent-actions/ascent-actions-menu';
import type { EditAscentValues } from '@/app/components/ascent-actions/edit-ascent-dialog';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import {
  UPDATE_TICK,
  DELETE_TICK,
  type UpdateTickMutationVariables,
  type UpdateTickMutationResponse,
  type DeleteTickMutationVariables,
  type DeleteTickMutationResponse,
} from '@/app/lib/graphql/operations';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './ascents-feed.module.css';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';

dayjs.extend(relativeTime);


interface AscentsFeedProps {
  userId: string;
  pageSize?: number;
  editable?: boolean;
}

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
  if (layoutId === null) return boardType.charAt(0).toUpperCase() + boardType.slice(1);
  const key = `${boardType}-${layoutId}`;
  return layoutNames[key] || `${boardType.charAt(0).toUpperCase() + boardType.slice(1)}`;
};

// Generate status summary for grouped attempts
const getGroupStatusSummary = (group: GroupedAscentFeedItem): { text: string; icon: React.ReactNode; color: string } => {
  const parts: string[] = [];

  if (group.flashCount > 0) {
    parts.push(group.flashCount === 1 ? 'Flashed' : `${group.flashCount} flashes`);
  }
  if (group.sendCount > 0) {
    parts.push(group.sendCount === 1 ? 'Sent' : `${group.sendCount} sends`);
  }
  if (group.attemptCount > 0) {
    parts.push(group.attemptCount === 1 ? '1 attempt' : `${group.attemptCount} attempts`);
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
    icon = <CancelOutlined />;
    color = 'default';
  }

  return { text: parts.join(', '), icon, color };
};

function getStatusChipColor(status: string): 'success' | 'primary' | 'default' {
  if (status === 'flash') return 'success';
  if (status === 'send') return 'primary';
  return 'default';
}

const AscentItemRow: React.FC<{
  item: AscentFeedItem;
  editable: boolean;
  onUpdate: (uuid: string, values: EditAscentValues) => void;
  onDelete: (uuid: string) => void;
  mutatingUuid: string | null;
}> = ({ item, editable, onUpdate, onDelete, mutatingUuid }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1,
      py: 0.5,
      borderTop: `1px solid ${themeTokens.neutral[100]}`,
    }}
  >
    <Chip
      label={item.status}
      size="small"
      color={getStatusChipColor(item.status)}
      variant={item.status === 'attempt' ? 'outlined' : 'filled'}
      sx={{ height: 20, '& .MuiChip-label': { px: 0.75, fontSize: themeTokens.typography.fontSize.xs - 1 } }}
    />
    <MuiTypography variant="caption" color="text.secondary">
      {item.attemptCount} attempt{item.attemptCount !== 1 ? 's' : ''}
    </MuiTypography>
    {item.quality != null && item.quality > 0 && (
      <Rating readOnly value={item.quality} max={5} size="small" sx={{ fontSize: 14 }} />
    )}
    <MuiTypography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
      {dayjs(item.climbedAt).format('MMM D, h:mm A')}
    </MuiTypography>
    {editable && (
      <AscentActionsMenu
        ascent={{
          uuid: item.uuid,
          status: item.status,
          attemptCount: item.attemptCount,
          quality: item.quality,
          comment: item.comment,
        }}
        onUpdate={onUpdate}
        onDelete={onDelete}
        updating={mutatingUuid === item.uuid}
        deleting={mutatingUuid === item.uuid}
      />
    )}
  </Box>
);

const GroupedFeedItem: React.FC<{
  group: GroupedAscentFeedItem;
  editable: boolean;
  onUpdate: (uuid: string, values: EditAscentValues) => void;
  onDelete: (uuid: string) => void;
  mutatingUuid: string | null;
}> = ({ group, editable, onUpdate, onDelete, mutatingUuid }) => {
  const [expanded, setExpanded] = useState(false);
  const latestItem = group.items.reduce((latest, item) =>
    new Date(item.climbedAt) > new Date(latest.climbedAt) ? item : latest
  );
  const timeAgo = dayjs(latestItem.climbedAt).fromNow();
  const boardDisplay = getLayoutDisplayName(group.boardType, group.layoutId);
  const statusSummary = getGroupStatusSummary(group);
  const hasSuccess = group.flashCount > 0 || group.sendCount > 0;
  const hasMultipleItems = group.items.length > 1;

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
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Chip
                icon={statusSummary.icon as React.ReactElement}
                label={statusSummary.text}
                size="small"
                color={statusSummary.color === 'green' ? 'success' : undefined}
                sx={statusSummary.color === 'gold' ? { bgcolor: themeTokens.colors.amber, color: 'var(--neutral-900)' } : undefined}
                className={styles.statusTag}
              />
              <MuiTypography variant="body2" component="span" fontWeight={600} className={styles.climbName}>
                {group.climbName}
              </MuiTypography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.timeAgo}>
                {timeAgo}
              </MuiTypography>
              {editable && !hasMultipleItems && group.items[0] && (
                <AscentActionsMenu
                  ascent={{
                    uuid: group.items[0].uuid,
                    status: group.items[0].status,
                    attemptCount: group.items[0].attemptCount,
                    quality: group.items[0].quality,
                    comment: group.items[0].comment,
                  }}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                  updating={mutatingUuid === group.items[0].uuid}
                  deleting={mutatingUuid === group.items[0].uuid}
                />
              )}
              {(editable && hasMultipleItems) && (
                <IconButton
                  size="small"
                  onClick={() => setExpanded((prev) => !prev)}
                  sx={{
                    transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                  }}
                >
                  <ExpandMoreOutlined fontSize="small" />
                </IconButton>
              )}
            </Box>
          </Box>

          <Box sx={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {group.difficultyName && (
              <Chip label={group.difficultyName} size="small" color="primary" />
            )}
            <Chip icon={<LocationOnOutlined />} label={`${group.angle}°`} size="small" />
            <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.boardType}>
              {boardDisplay}
            </MuiTypography>
            {group.isMirror && <Chip label="Mirrored" size="small" color="secondary" />}
            {group.isBenchmark && <Chip label="Benchmark" size="small" />}
          </Box>

          {hasSuccess && group.bestQuality && (
            <Rating readOnly value={group.bestQuality} max={5} className={styles.rating} />
          )}

          {group.setterUsername && (
            <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.setter}>
              Set by {group.setterUsername}
            </MuiTypography>
          )}

          {group.latestComment && (
            <MuiTypography variant="body2" component="span" className={styles.comment}>{group.latestComment}</MuiTypography>
          )}

          {/* Expandable individual items for edit/delete */}
          {editable && hasMultipleItems && (
            <Collapse in={expanded} unmountOnExit>
              <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                {group.items.map((item) => (
                  <AscentItemRow
                    key={item.uuid}
                    item={item}
                    editable
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    mutatingUuid={mutatingUuid}
                  />
                ))}
              </Box>
            </Collapse>
          )}
        </Box>
      </Box>
      </CardContent>
    </MuiCard>
  );
};

export const AscentsFeed: React.FC<AscentsFeedProps> = ({ userId, pageSize = 10, editable = false }) => {
  const { token } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();
  const [mutatingUuid, setMutatingUuid] = useState<string | null>(null);

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
        variables
      );
      return response.userGroupedAscentsFeed;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.groups.length;
    },
    staleTime: 60 * 1000,
  });

  const groups: GroupedAscentFeedItem[] = useMemo(
    () => data?.pages.flatMap((p) => p.groups) ?? [],
    [data],
  );

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  const handleUpdate = useCallback(async (uuid: string, values: EditAscentValues) => {
    if (!token) return;
    setMutatingUuid(uuid);
    try {
      const client = createGraphQLHttpClient(token);
      const variables: UpdateTickMutationVariables = {
        input: {
          uuid,
          status: values.status,
          attemptCount: values.attemptCount,
          quality: values.quality,
          comment: values.comment,
        },
      };
      await client.request<UpdateTickMutationResponse>(UPDATE_TICK, variables);
      showMessage('Ascent updated', 'success');
      queryClient.invalidateQueries({ queryKey: ['ascentsFeed', userId] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update ascent';
      showMessage(message, 'error');
    } finally {
      setMutatingUuid(null);
    }
  }, [token, userId, queryClient, showMessage]);

  const handleDelete = useCallback(async (uuid: string) => {
    if (!token) return;
    setMutatingUuid(uuid);
    try {
      const client = createGraphQLHttpClient(token);
      const variables: DeleteTickMutationVariables = {
        input: { uuid },
      };
      await client.request<DeleteTickMutationResponse>(DELETE_TICK, variables);
      showMessage('Ascent deleted', 'success');
      queryClient.invalidateQueries({ queryKey: ['ascentsFeed', userId] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete ascent';
      showMessage(message, 'error');
    } finally {
      setMutatingUuid(null);
    }
  }, [token, userId, queryClient, showMessage]);

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <CircularProgress />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        description="Failed to load activity feed"
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        description="No ascents logged yet"
      />
    );
  }

  return (
    <div className={styles.feed}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {groups.map((group) => (
          <GroupedFeedItem
            key={group.key}
            group={group}
            editable={editable}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            mutatingUuid={mutatingUuid}
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
