'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import MuiTypography from '@mui/material/Typography';
import ArrowUpwardOutlined from '@mui/icons-material/ArrowUpwardOutlined';
import ArrowDownwardOutlined from '@mui/icons-material/ArrowDownwardOutlined';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import FavoriteOutlined from '@mui/icons-material/FavoriteOutlined';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  VOTE,
  GET_VOTE_SUMMARY,
  type VoteMutationVariables,
  type VoteMutationResponse,
  type GetVoteSummaryQueryVariables,
  type GetVoteSummaryQueryResponse,
} from '@boardsesh/graphql/operations';
import { themeTokens } from '@/app/theme/theme-config';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { useVoteSummaryContext } from './vote-summary-context';

type VoteButtonProps = {
  entityType: SocialEntityType;
  entityId: string;
  initialUpvotes?: number;
  initialDownvotes?: number;
  initialUserVote?: number;
  layout?: 'vertical' | 'horizontal';
  likeOnly?: boolean;
  onVoteChange?: (summary: { upvotes: number; downvotes: number; voteScore: number; userVote: number }) => void;
};

export default function VoteButton({
  entityType,
  entityId,
  initialUpvotes = 0,
  initialDownvotes = 0,
  initialUserVote,
  layout = 'horizontal',
  likeOnly = false,
  onVoteChange,
}: VoteButtonProps) {
  // Check for batch-fetched vote data from a parent VoteSummaryProvider
  const voteSummaryCtx = useVoteSummaryContext();
  const batchSummary = voteSummaryCtx?.getVoteSummary(entityId);

  const { t } = useTranslation('common');
  const [upvotes, setUpvotes] = useState(initialUpvotes);
  const [downvotes, setDownvotes] = useState(initialDownvotes);
  const [userVote, setUserVote] = useState(initialUserVote ?? 0);
  const [isLoading, setIsLoading] = useState(false);
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();

  const hasVotedRef = useRef(false);

  // Sync state when batch context data arrives asynchronously
  const appliedBatchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!batchSummary || initialUserVote !== undefined) return;
    const key = `${batchSummary.entityId}:${batchSummary.userVote}:${batchSummary.upvotes}:${batchSummary.downvotes}`;
    if (appliedBatchRef.current === key) return;
    appliedBatchRef.current = key;
    if (!hasVotedRef.current) {
      setUpvotes(batchSummary.upvotes);
      setDownvotes(batchSummary.downvotes);
      setUserVote(batchSummary.userVote);
    }
  }, [batchSummary, initialUserVote]);

  // Fallback: fetch individually only when no data is provided by props or batch context,
  // and no VoteSummaryProvider is present (which handles the fetch in bulk).
  const fetchedEntityRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !token) return;
    if (initialUserVote !== undefined) return;
    if (voteSummaryCtx) return;

    const key = `${entityType}:${entityId}`;
    if (fetchedEntityRef.current === key) return;
    fetchedEntityRef.current = key;

    let cancelled = false;

    const fetchVoteSummary = async () => {
      try {
        const client = createGraphQLHttpClient(token);
        const response = await client.request<GetVoteSummaryQueryResponse, GetVoteSummaryQueryVariables>(
          GET_VOTE_SUMMARY,
          { entityType, entityId },
        );
        if (!cancelled && !hasVotedRef.current) {
          const summary = response.voteSummary;
          setUpvotes(summary.upvotes);
          setDownvotes(summary.downvotes);
          setUserVote(summary.userVote);
        }
      } catch {
        // Silently fail — fall back to initial props
      }
    };

    void fetchVoteSummary();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, token, entityType, entityId, initialUserVote, voteSummaryCtx]);

  const handleVote = useCallback(
    async (value: 1 | -1) => {
      if (!isAuthenticated || !token) {
        showMessage(t('vote.signInPrompt'), 'info');
        return;
      }

      // Optimistic update
      const prevUpvotes = upvotes;
      const prevDownvotes = downvotes;
      const prevUserVote = userVote;

      let newUserVote: number;
      let newUpvotes = upvotes;
      let newDownvotes = downvotes;

      if (userVote === value) {
        // Toggle off
        newUserVote = 0;
        if (value === 1) newUpvotes--;
        else newDownvotes--;
      } else {
        // Remove previous vote if exists
        if (userVote === 1) newUpvotes--;
        if (userVote === -1) newDownvotes--;
        // Add new vote
        newUserVote = value;
        if (value === 1) newUpvotes++;
        else newDownvotes++;
      }

      hasVotedRef.current = true;
      setUpvotes(newUpvotes);
      setDownvotes(newDownvotes);
      setUserVote(newUserVote);
      onVoteChange?.({
        upvotes: newUpvotes,
        downvotes: newDownvotes,
        voteScore: newUpvotes - newDownvotes,
        userVote: newUserVote,
      });

      setIsLoading(true);
      try {
        const client = createGraphQLHttpClient(token);
        const response = await client.request<VoteMutationResponse, VoteMutationVariables>(VOTE, {
          input: { entityType, entityId, value },
        });

        // Use server response as source of truth
        const s = response.vote;
        setUpvotes(s.upvotes);
        setDownvotes(s.downvotes);
        setUserVote(s.userVote);
        onVoteChange?.(s);
      } catch {
        // Revert optimistic update
        setUpvotes(prevUpvotes);
        setDownvotes(prevDownvotes);
        setUserVote(prevUserVote);
        onVoteChange?.({
          upvotes: prevUpvotes,
          downvotes: prevDownvotes,
          voteScore: prevUpvotes - prevDownvotes,
          userVote: prevUserVote,
        });
        showMessage(t('vote.failed'), 'error');
      } finally {
        setIsLoading(false);
      }
    },
    [upvotes, downvotes, userVote, isAuthenticated, token, entityType, entityId, onVoteChange, showMessage, t],
  );

  const score = upvotes - downvotes;
  const isVertical = layout === 'vertical';
  const isLiked = userVote === 1;

  if (likeOnly) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton
          size="small"
          onClick={() => handleVote(1)}
          disabled={isLoading}
          aria-label={isLiked ? t('vote.unlike') : t('vote.like')}
          sx={{
            color: isLiked ? 'var(--color-error)' : 'var(--neutral-400)',
            p: 0.5,
          }}
        >
          {isLiked ? <FavoriteOutlined sx={{ fontSize: 18 }} /> : <FavoriteBorderOutlined sx={{ fontSize: 18 }} />}
        </IconButton>
        {upvotes > 0 && (
          <MuiTypography
            variant="body2"
            sx={{
              color: isLiked ? 'var(--color-error)' : 'var(--neutral-500)',
              fontSize: themeTokens.typography.fontSize.xs,
            }}
          >
            {upvotes}
          </MuiTypography>
        )}
      </Box>
    );
  }

  let scoreColor: string;
  if (userVote === 1) {
    scoreColor = 'var(--color-success)';
  } else if (userVote === -1) {
    scoreColor = 'var(--color-error)';
  } else {
    scoreColor = 'var(--neutral-600)';
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: isVertical ? 'column' : 'row',
        alignItems: 'center',
        gap: 0,
      }}
    >
      <IconButton
        size="small"
        onClick={() => handleVote(1)}
        disabled={isLoading}
        aria-label={t('vote.upvote')}
        sx={{
          color: userVote === 1 ? 'var(--color-success)' : 'var(--neutral-400)',
          p: 0.5,
        }}
      >
        <ArrowUpwardOutlined sx={{ fontSize: 20 }} />
      </IconButton>
      <MuiTypography
        variant="body2"
        fontWeight={600}
        sx={{
          minWidth: 20,
          textAlign: 'center',
          color: scoreColor,
        }}
      >
        {score}
      </MuiTypography>
      <IconButton
        size="small"
        onClick={() => handleVote(-1)}
        disabled={isLoading}
        aria-label={t('vote.downvote')}
        sx={{
          color: userVote === -1 ? 'var(--color-error)' : 'var(--neutral-400)',
          p: 0.5,
        }}
      >
        <ArrowDownwardOutlined sx={{ fontSize: 20 }} />
      </IconButton>
    </Box>
  );
}
