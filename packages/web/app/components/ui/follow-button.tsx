'use client';

import React from 'react';
import { AccountFollowButton } from './account-follow-button';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useTranslation } from 'react-i18next';
import { useFollowToggle } from '@/app/hooks/use-follow-toggle';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';

type FollowButtonProps = {
  entityId: string;
  initialIsFollowing: boolean;
  followMutation: TypedDocumentNode | string;
  unfollowMutation: TypedDocumentNode | string;
  entityLabel: string;
  getFollowVariables: (entityId: string) => Record<string, unknown>;
  onFollowChange?: (isFollowing: boolean) => void;
  /** Optional click hook — see `useFollowToggle`. Only the gym page passes one. */
  onToggleClick?: () => void;
};

function GenericFollowButton({
  entityId,
  initialIsFollowing,
  followMutation,
  unfollowMutation,
  entityLabel,
  getFollowVariables,
  onFollowChange,
  onToggleClick,
}: FollowButtonProps) {
  const { t } = useTranslation('common');
  const { isFollowing, isLoading, isHovered, isAuthenticated, handleToggle, setIsHovered } = useFollowToggle({
    entityId,
    initialIsFollowing,
    followMutation,
    unfollowMutation,
    entityLabel,
    getFollowVariables,
    onFollowChange,
    onToggleClick,
  });

  if (!isAuthenticated) {
    return null;
  }

  const getButtonLabel = () => {
    if (isLoading) return <CircularProgress size={16} color="inherit" />;
    if (isFollowing && isHovered) return t('follow.unfollow');
    if (isFollowing) return t('follow.following');
    return t('follow.follow');
  };

  return (
    <MuiButton
      variant={isFollowing ? 'outlined' : 'contained'}
      size="small"
      onClick={handleToggle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      disabled={isLoading}
      color={isFollowing && isHovered ? 'error' : 'primary'}
      sx={{ minWidth: 90, textTransform: 'none' }}
    >
      {getButtonLabel()}
    </MuiButton>
  );
}

export default function FollowButton(props: FollowButtonProps) {
  if (props.entityLabel === 'user')
    return (
      <AccountFollowButton
        userId={props.entityId}
        onFollowChange={props.onFollowChange}
        fallback={<GenericFollowButton {...props} />}
      />
    );
  return <GenericFollowButton {...props} />;
}
