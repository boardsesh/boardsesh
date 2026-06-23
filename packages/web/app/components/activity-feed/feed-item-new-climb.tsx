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
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { ActivityFeedItem } from '@boardsesh/shared-schema';
import AscentThumbnail from './ascent-thumbnail';
import VoteButton from '@/app/components/social/vote-button';
import CommentSection from '@/app/components/social/comment-section';
import ClimbIcons from '@/app/components/climb-card/climb-icons';
import styles from './ascents-feed.module.css';

dayjs.extend(relativeTime);

type FeedItemNewClimbProps = {
  item: ActivityFeedItem;
};

export default function FeedItemNewClimb({ item }: FeedItemNewClimbProps) {
  const { t } = useTranslation('feed');
  const [commentsOpen, setCommentsOpen] = useState(false);
  const timeAgo = dayjs(item.createdAt).fromNow();
  const actorProfileHref = item.actorId ? `/profile/${item.actorId}` : null;

  return (
    <MuiCard className={styles.feedItem} data-testid="activity-feed-item">
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* User header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <MuiAvatar
            src={item.actorAvatarUrl ?? undefined}
            sx={{ width: 32, height: 32 }}
            {...(actorProfileHref ? { component: LocaleLink, href: actorProfileHref } : {})}
          >
            {!item.actorAvatarUrl && <PersonOutlined sx={{ fontSize: 16 }} />}
          </MuiAvatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <MuiTypography
              variant="body2"
              fontWeight={600}
              {...(actorProfileHref ? { component: LocaleLink, href: actorProfileHref } : {})}
              sx={{ textDecoration: 'none', color: 'text.primary' }}
            >
              {item.actorDisplayName || 'User'}
            </MuiTypography>
            <MuiTypography variant="body2" component="span" color="text.secondary">
              {' '}
              {t('feedItemNewClimb.createdClimb')}{' '}
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

        {/* Content row with thumbnail */}
        <Box sx={{ display: 'flex', gap: '12px' }}>
          {item.frames && item.layoutId && (
            <AscentThumbnail
              boardType={item.boardType || ''}
              layoutId={item.layoutId}
              angle={item.angle || 0}
              climbUuid={item.climbUuid || ''}
              climbName={item.climbName || ''}
              frames={item.frames}
              isMirror={item.isMirror ?? false}
            />
          )}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }} className={styles.feedItemContent}>
            <Box sx={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {item.difficultyName && <Chip label={item.difficultyName} size="small" color="primary" />}
              {item.angle != null && <Chip icon={<LocationOnOutlined />} label={`${item.angle}\u00B0`} size="small" />}
              {item.boardType && (
                <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.boardType}>
                  {item.boardType.charAt(0).toUpperCase() + item.boardType.slice(1)}
                </MuiTypography>
              )}
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
              <VoteButton entityType="climb" entityId={item.climbUuid || item.entityId} likeOnly />
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
            <CommentSection
              entityType="climb"
              entityId={item.climbUuid || item.entityId}
              title={t('feedCommentButton.commentsTitle')}
            />
          </Box>
        </Collapse>
      </CardContent>
    </MuiCard>
  );
}
