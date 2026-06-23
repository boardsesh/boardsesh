'use client';

import React from 'react';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import Avatar from '@mui/material/Avatar';
import AvatarGroup from '@mui/material/AvatarGroup';
import MuiTypography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import PersonAddOutlined from '@mui/icons-material/PersonAddOutlined';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import ThumbUpOutlined from '@mui/icons-material/ThumbUpOutlined';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import AddCircleOutline from '@mui/icons-material/AddCircleOutline';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { GroupedNotification, NotificationType } from '@boardsesh/shared-schema';

type NotificationItemProps = {
  notification: GroupedNotification;
  onClick: (notification: GroupedNotification) => void;
};

function formatTimeAgo(dateStr: string, t: TFunction): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return t('time.justNow');
  if (diffMinutes < 60) return t('time.minutes', { count: diffMinutes });
  if (diffHours < 24) return t('time.hours', { count: diffHours });
  if (diffDays < 7) return t('time.days', { count: diffDays });
  return date.toLocaleDateString();
}

function getActorSummary(notification: GroupedNotification, t: TFunction): string {
  const { actors, actorCount } = notification;
  if (actors.length === 0) return t('actorSummary.fallback');

  const firstActor = actors[0].displayName || t('actorSummary.fallback');

  if (actorCount === 1) return firstActor;

  if (actorCount === 2 && actors.length >= 2) {
    const secondActor = actors[1].displayName || t('actorSummary.secondaryFallback');
    return t('actorSummary.two', { first: firstActor, second: secondActor });
  }

  const othersCount = actorCount - 1;
  if (othersCount === 1) {
    return t('actorSummary.manyOne', { first: firstActor });
  }
  return t('actorSummary.many', { first: firstActor, count: othersCount });
}

function getNotificationText(notification: GroupedNotification, t: TFunction): string {
  const actor = getActorSummary(notification, t);
  switch (notification.type) {
    case 'new_follower':
      return t('items.newFollower', { actor });
    case 'comment_reply':
      return notification.commentBody
        ? t('items.commentReplyWithBody', { actor, body: notification.commentBody })
        : t('items.commentReply', { actor });
    case 'comment_on_tick':
      return notification.commentBody
        ? t('items.commentOnTickWithBody', { actor, body: notification.commentBody })
        : t('items.commentOnTick', { actor });
    case 'comment_on_climb':
      return notification.commentBody
        ? t('items.commentOnClimbWithBody', { actor, body: notification.commentBody })
        : t('items.commentOnClimb', { actor });
    case 'vote_on_tick':
      return t('items.voteOnTick', { actor });
    case 'vote_on_comment':
      return t('items.voteOnComment', { actor });
    case 'proposal_created':
      return t('items.proposalCreated', { actor });
    case 'proposal_approved':
      return t('items.proposalApproved', { actor });
    case 'proposal_rejected':
      return t('items.proposalRejected', { actor });
    case 'proposal_vote':
      return t('items.proposalVote', { actor });
    case 'new_climb':
    case 'new_climb_global':
      return t('items.newClimb', { actor });
    case 'new_climbs_synced':
      return notification.setterUsername
        ? t('items.newClimbsSyncedSetter', { setter: notification.setterUsername })
        : t('items.newClimbsSynced', { actor });
    default:
      return t('items.default');
  }
}

function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case 'new_follower':
      return <PersonAddOutlined fontSize="small" />;
    case 'comment_reply':
    case 'comment_on_tick':
    case 'comment_on_climb':
      return <ChatBubbleOutline fontSize="small" />;
    case 'vote_on_tick':
    case 'vote_on_comment':
      return <ThumbUpOutlined fontSize="small" />;
    case 'proposal_created':
    case 'proposal_approved':
    case 'proposal_rejected':
    case 'proposal_vote':
      return <LightbulbOutlined fontSize="small" />;
    case 'new_climb':
    case 'new_climb_global':
    case 'new_climbs_synced':
      return <AddCircleOutline fontSize="small" />;
    default:
      return null;
  }
}

export default function NotificationItem({ notification, onClick }: NotificationItemProps) {
  const { t } = useTranslation('notifications');
  const { actors, actorCount } = notification;
  const showAvatarGroup = actorCount > 1 && actors.length > 1;

  return (
    <ListItem
      onClick={() => onClick(notification)}
      sx={{
        cursor: 'pointer',
        backgroundColor: notification.isRead ? 'transparent' : 'var(--semantic-selected-light)',
        '&:hover': { backgroundColor: 'var(--neutral-100)' },
        borderBottom: `1px solid var(--neutral-200)`,
        py: 1.5,
        px: 2,
      }}
    >
      <ListItemAvatar sx={{ minWidth: showAvatarGroup ? 56 : undefined }}>
        {showAvatarGroup ? (
          <AvatarGroup max={3} sx={{ '& .MuiAvatar-root': { width: 28, height: 28, fontSize: 12 } }}>
            {actors.map((actor) => (
              <Avatar key={actor.id} src={actor.avatarUrl || undefined}>
                {getNotificationIcon(notification.type)}
              </Avatar>
            ))}
          </AvatarGroup>
        ) : (
          <Avatar src={actors[0]?.avatarUrl || undefined} sx={{ width: 40, height: 40 }}>
            {getNotificationIcon(notification.type)}
          </Avatar>
        )}
      </ListItemAvatar>
      <ListItemText
        disableTypography
        primary={
          <MuiTypography
            variant="body2"
            sx={{
              fontWeight: notification.isRead ? 400 : 600,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {getNotificationText(notification, t)}
          </MuiTypography>
        }
        secondary={
          <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
            <MuiTypography variant="caption" color="text.secondary">
              {formatTimeAgo(notification.createdAt, t)}
            </MuiTypography>
            {!notification.isRead && (
              <Box
                component="span"
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: 'var(--color-primary-fill)',
                  ml: 0.5,
                }}
              />
            )}
          </Box>
        }
      />
    </ListItem>
  );
}
