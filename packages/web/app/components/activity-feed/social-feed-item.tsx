'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import MuiTypography from '@mui/material/Typography';
import MuiAvatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ElectricBoltOutlined from '@mui/icons-material/ElectricBoltOutlined';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import { formatTickRelativeTime } from '@/app/lib/format-tick-time';
import type { FollowingAscentFeedItem } from '@boardsesh/shared-schema';
import AscentThumbnail from './ascent-thumbnail';
import VoteButton from '@/app/components/social/vote-button';
import CommentSection from '@/app/components/social/comment-section';
import ClimbIcons from '@/app/components/climb-card/climb-icons';
import { themeTokens } from '@/app/theme/theme-config';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import styles from './ascents-feed.module.css';

// Layout name mapping (shared with ascents-feed.tsx)
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

const getStatusDisplay = (status: string) => {
  switch (status) {
    case 'flash':
      return { label: 'Flash', icon: <ElectricBoltOutlined />, color: themeTokens.colors.amber };
    case 'send':
      return { label: 'Send', icon: <CheckCircleOutlined />, chipColor: 'success' as const };
    case 'attempt':
      return { label: 'Attempt', icon: <PersonFallingIcon />, chipColor: undefined };
    default:
      return { label: status, icon: null, chipColor: undefined };
  }
};

type SocialFeedItemProps = {
  item: FollowingAscentFeedItem;
  showUserHeader?: boolean;
};

const SocialFeedItem: React.FC<SocialFeedItemProps> = ({ item, showUserHeader = false }) => {
  const { t } = useTranslation('feed');
  const [commentsOpen, setCommentsOpen] = useState(false);
  const timeAgo = formatTickRelativeTime(item.climbedAt);
  const statusDisplay = getStatusDisplay(item.status);
  const boardDisplay = getLayoutDisplayName(item.boardType, item.layoutId ?? null);

  return (
    <MuiCard className={styles.feedItem}>
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* User header */}
        {showUserHeader && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <MuiAvatar
              src={item.userAvatarUrl ?? undefined}
              sx={{ width: 32, height: 32 }}
              component={LocaleLink}
              href={`/profile/${item.userId}`}
            >
              {!item.userAvatarUrl && <PersonOutlined sx={{ fontSize: 16 }} />}
            </MuiAvatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <MuiTypography
                variant="body2"
                fontWeight={600}
                component={LocaleLink}
                href={`/profile/${item.userId}`}
                sx={{ textDecoration: 'none', color: 'text.primary' }}
              >
                {item.userDisplayName || 'User'}
              </MuiTypography>
              <MuiTypography variant="body2" component="span" color="text.secondary">
                {' '}
                {t('socialFeedItem.climbed')}{' '}
              </MuiTypography>
              <MuiTypography variant="body2" component="span" fontWeight={600}>
                {item.climbName}
                <ClimbIcons isNoMatch={!!item.isNoMatch} isBenchmark={!!item.isBenchmark} />
              </MuiTypography>
            </Box>
            <MuiTypography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              {timeAgo}
            </MuiTypography>
          </Box>
        )}

        {/* Content row with thumbnail */}
        <Box sx={{ display: 'flex', gap: '12px' }}>
          {/* Thumbnail */}
          {item.frames && item.layoutId && (
            <AscentThumbnail
              boardType={item.boardType}
              layoutId={item.layoutId}
              angle={item.angle}
              climbUuid={item.climbUuid}
              climbName={item.climbName}
              frames={item.frames}
              isMirror={item.isMirror}
            />
          )}

          {/* Details */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }} className={styles.feedItemContent}>
            {/* Status and climb name row */}
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
                  icon={statusDisplay.icon as React.ReactElement}
                  label={statusDisplay.label}
                  size="small"
                  color={statusDisplay.chipColor}
                  sx={statusDisplay.color ? { bgcolor: statusDisplay.color, color: 'var(--neutral-900)' } : undefined}
                  className={styles.statusTag}
                />
                {!showUserHeader && (
                  <MuiTypography variant="body2" component="span" fontWeight={600} className={styles.climbName}>
                    {item.climbName}
                    <ClimbIcons isNoMatch={!!item.isNoMatch} isBenchmark={!!item.isBenchmark} />
                  </MuiTypography>
                )}
              </Box>
              {!showUserHeader && (
                <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.timeAgo}>
                  {timeAgo}
                </MuiTypography>
              )}
            </Box>

            {/* Climb details chips */}
            <Box sx={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {item.difficultyName && <Chip label={item.difficultyName} size="small" color="primary" />}
              <Chip icon={<LocationOnOutlined />} label={`${item.angle}\u00B0`} size="small" />
              <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.boardType}>
                {boardDisplay}
              </MuiTypography>
              {item.isMirror && <Chip label={t('ascentsFeed.mirrored')} size="small" color="secondary" />}
              {item.isBenchmark && <Chip label={t('ascentsFeed.benchmark')} size="small" />}
            </Box>

            {/* Comment */}
            {item.comment && (
              <MuiTypography variant="body2" component="span" className={styles.comment}>
                {item.comment}
              </MuiTypography>
            )}

            {/* Vote & Comment */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
              <VoteButton entityType="tick" entityId={item.uuid} likeOnly />
              <IconButton
                size="small"
                onClick={() => setCommentsOpen((prev) => !prev)}
                sx={{ color: commentsOpen ? 'var(--color-primary)' : 'text.secondary' }}
              >
                <ChatBubbleOutlineOutlined fontSize="small" />
              </IconButton>
            </Box>
          </Box>
        </Box>

        {/* Comments */}
        <Collapse in={commentsOpen} unmountOnExit>
          <Box sx={{ mt: 1 }}>
            <CommentSection entityType="tick" entityId={item.uuid} title={t('feedCommentButton.commentsTitle')} />
          </Box>
        </Collapse>
      </CardContent>
    </MuiCard>
  );
};

export default SocialFeedItem;
