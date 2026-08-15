'use client';

import { useState, useCallback, useEffect } from 'react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';

type UseFollowToggleConfig = {
  entityId: string;
  initialIsFollowing: boolean;
  followMutation: TypedDocumentNode | string;
  unfollowMutation: TypedDocumentNode | string;
  entityLabel: string;
  getFollowVariables: (entityId: string) => Record<string, unknown>;
  onFollowChange?: (isFollowing: boolean) => void;
  /**
   * Fired once per accepted click, after the auth guard and before any state
   * moves. Deliberately separate from `onFollowChange`, which fires optimistically
   * and AGAIN on rollback — instrumenting a click through that callback would
   * report a phantom unfollow every time the mutation failed.
   */
  onToggleClick?: () => void;
};

export function useFollowToggle({
  entityId,
  initialIsFollowing,
  followMutation,
  unfollowMutation,
  entityLabel,
  getFollowVariables,
  onFollowChange,
  onToggleClick,
}: UseFollowToggleConfig) {
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing);
  // Sync internal state when the prop changes (e.g. after parent re-fetches)
  useEffect(() => {
    setIsFollowing(initialIsFollowing);
  }, [initialIsFollowing]);
  const [isLoading, setIsLoading] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();

  const handleToggle = useCallback(async () => {
    if (!isAuthenticated || !token) {
      showMessage(`Sign in to follow ${entityLabel}s`, 'info');
      return;
    }

    onToggleClick?.();

    const previousState = isFollowing;
    setIsFollowing(!isFollowing);
    onFollowChange?.(!isFollowing);
    setIsLoading(true);

    try {
      const client = createGraphQLHttpClient(token);
      const variables = getFollowVariables(entityId);

      if (previousState) {
        await client.request(unfollowMutation, variables);
      } else {
        await client.request(followMutation, variables);
      }
    } catch (error) {
      setIsFollowing(previousState);
      onFollowChange?.(previousState);
      showMessage('Failed to update follow status', 'error');
      console.error(`${entityLabel} follow toggle error:`, error);
    } finally {
      setIsLoading(false);
    }
  }, [
    isFollowing,
    isAuthenticated,
    token,
    entityId,
    entityLabel,
    followMutation,
    unfollowMutation,
    getFollowVariables,
    onFollowChange,
    onToggleClick,
    showMessage,
  ]);

  return {
    isFollowing,
    isLoading,
    isHovered,
    isAuthenticated,
    handleToggle,
    setIsHovered,
  };
}
