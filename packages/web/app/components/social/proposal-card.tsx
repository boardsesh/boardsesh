'use client';

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Avatar from '@mui/material/Avatar';
import Tooltip from '@mui/material/Tooltip';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Snackbar from '@mui/material/Snackbar';
import { useTheme } from '@mui/material/styles';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { VOTE_ON_PROPOSAL, RESOLVE_PROPOSAL, DELETE_PROPOSAL } from '@boardsesh/graphql/operations/proposals';
import type { Proposal } from '@boardsesh/shared-schema';
import { usePathname } from 'next/navigation';
import type { Climb, BoardDetails, BoardName } from '@/app/lib/types';
import ClimbListItem from '@/app/components/climb-card/climb-list-item';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';

import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getDefaultBoardConfig } from '@/app/lib/default-board-configs';
import ProposalVoteBar from './proposal-vote-bar';
import FeedCommentButton from './feed-comment-button';

const TYPE_LABELS: Record<string, string> = {
  grade: 'Grade',
  classic: 'Classic',
  benchmark: 'Benchmark',
};

type ProposalCardProps = {
  proposal: Proposal;
  isAdminOrLeader?: boolean;
  onUpdate?: (updated: Proposal) => void;
  onDelete?: (proposalUuid: string) => void;
  highlight?: boolean;
};

export default function ProposalCard({ proposal, isAdminOrLeader, onUpdate, onDelete, highlight }: ProposalCardProps) {
  const { t } = useTranslation('common');
  const theme = useTheme();
  const pathname = usePathname();
  const isDark = useIsDarkMode();
  const { token } = useWsAuthToken();
  const [loading, setLoading] = useState(false);
  const [snackbar, setSnackbar] = useState('');
  const [localProposal, setLocalProposal] = useState(proposal);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlight && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlight]);

  const handleVote = useCallback(
    async (value: number) => {
      if (!token) {
        setSnackbar(t('proposal.validation.signInToVote'));
        return;
      }
      setLoading(true);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<{ voteOnProposal: Proposal }>(VOTE_ON_PROPOSAL, {
          input: { proposalUuid: localProposal.uuid, value },
        });
        setLocalProposal(result.voteOnProposal);
        onUpdate?.(result.voteOnProposal);
      } catch {
        setSnackbar(t('proposal.validation.failedToVote'));
      } finally {
        setLoading(false);
      }
    },
    [token, localProposal.uuid, onUpdate, t],
  );

  const handleResolve = useCallback(
    async (status: 'approved' | 'rejected') => {
      if (!token) return;
      setLoading(true);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<{ resolveProposal: Proposal }>(RESOLVE_PROPOSAL, {
          input: { proposalUuid: localProposal.uuid, status },
        });
        setLocalProposal(result.resolveProposal);
        onUpdate?.(result.resolveProposal);
      } catch {
        setSnackbar(t('proposal.validation.failedToResolve'));
      } finally {
        setLoading(false);
      }
    },
    [token, localProposal.uuid, onUpdate, t],
  );

  const handleDelete = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const client = createGraphQLHttpClient(token);
      await client.request<{ deleteProposal: boolean }>(DELETE_PROPOSAL, {
        input: { proposalUuid: localProposal.uuid },
      });
      setShowDeleteDialog(false);
      onDelete?.(localProposal.uuid);
    } catch {
      setSnackbar(t('proposal.validation.failedToDelete'));
    } finally {
      setLoading(false);
    }
  }, [token, localProposal.uuid, onDelete, t]);

  const climbAndBoardDetails = useMemo(() => {
    const { climbUuid, climbName, frames, layoutId, boardType, angle } = localProposal;
    if (!climbName && !frames) return null;
    if (!layoutId || !boardType) return null;

    const boardName = boardType as BoardName;
    const config = getDefaultBoardConfig(boardName, layoutId);
    if (!config) return null;

    let boardDetails: BoardDetails;
    try {
      boardDetails = getBoardDetailsForBoard({
        board_name: boardName,
        layout_id: layoutId,
        size_id: config.sizeId,
        set_ids: config.setIds,
      });
    } catch {
      return null;
    }

    const climb: Climb = {
      uuid: climbUuid,
      name: climbName || '',
      setter_username: localProposal.climbSetterUsername || '',
      description: '',
      frames: frames || '',
      angle: angle ?? 0,
      ascensionist_count: localProposal.climbAscensionistCount ?? 0,
      difficulty: localProposal.climbDifficulty || '',
      quality_average: localProposal.climbQualityAverage || '0',
      stars: 0,
      difficulty_error: localProposal.climbDifficultyError || '0',
      benchmark_difficulty: localProposal.climbBenchmarkDifficulty || null,
      is_no_match: !!localProposal.climbIsNoMatch,
      layoutId,
      boardType,
    };

    return { climb, boardDetails };
  }, [localProposal]);

  const typeColorByType: Record<string, string> = {
    grade: theme.palette.primary.main,
    classic: themeTokens.colors.amber,
    benchmark: themeTokens.colors.purple,
  };
  const typeColor = typeColorByType[localProposal.type] || themeTokens.neutral[500];

  return (
    <>
      <Card
        ref={cardRef}
        variant="outlined"
        data-testid="proposal-card"
        sx={{
          mb: 1.5,
          borderColor: highlight ? 'var(--color-primary)' : themeTokens.neutral[200],
          boxShadow: highlight ? '0 0 0 1px var(--color-primary)' : undefined,
          '&:hover': { borderColor: themeTokens.neutral[300] },
        }}
      >
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          {/* Climb preview */}
          {climbAndBoardDetails && (
            <ClimbListItem
              climb={climbAndBoardDetails.climb}
              boardDetails={climbAndBoardDetails.boardDetails}
              pathname={pathname}
              isDark={isDark}
              disableSwipe
            />
          )}

          {/* Header */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <Avatar src={localProposal.proposerAvatarUrl || undefined} sx={{ width: 28, height: 28, fontSize: 14 }}>
              {localProposal.proposerDisplayName?.[0] || 'U'}
            </Avatar>
            <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
              {localProposal.proposerDisplayName || 'User'}
            </Typography>
            <Chip
              label={TYPE_LABELS[localProposal.type] || localProposal.type}
              size="small"
              sx={{
                bgcolor: `${typeColor}14`,
                color: typeColor,
                fontWeight: 600,
                fontSize: 11,
              }}
            />
          </Box>

          {/* Value change */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
            <Chip label={localProposal.currentValue} size="small" variant="outlined" sx={{ fontSize: 13 }} />
            <ArrowForwardIcon sx={{ fontSize: 16, color: themeTokens.neutral[400] }} />
            <Chip
              label={localProposal.proposedValue}
              size="small"
              sx={{
                bgcolor: 'var(--color-primary-fill)',
                color: '#fff',
                fontWeight: 600,
                fontSize: 13,
              }}
            />
          </Box>

          {/* Reason */}
          {localProposal.reason && (
            <Typography variant="body2" sx={{ color: themeTokens.neutral[600], mb: 1.5, fontStyle: 'italic' }}>
              {t('feed:proposalCard.quotedReason', { reason: localProposal.reason })}
            </Typography>
          )}

          {/* Vote bar */}
          <ProposalVoteBar
            weightedUpvotes={localProposal.weightedUpvotes}
            weightedDownvotes={localProposal.weightedDownvotes}
            requiredUpvotes={localProposal.requiredUpvotes}
            status={localProposal.status}
          />

          {/* Vote buttons + admin actions */}
          {localProposal.status === 'open' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
              <Tooltip title={t('feed:proposalCard.support')}>
                <IconButton
                  size="small"
                  disabled={loading}
                  onClick={() => handleVote(1)}
                  sx={{
                    color: localProposal.userVote === 1 ? 'var(--color-success)' : themeTokens.neutral[400],
                  }}
                >
                  {localProposal.userVote === 1 ? (
                    <ThumbUpIcon fontSize="small" />
                  ) : (
                    <ThumbUpOutlinedIcon fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>
              <Tooltip title={t('feed:proposalCard.oppose')}>
                <IconButton
                  size="small"
                  disabled={loading}
                  onClick={() => handleVote(-1)}
                  sx={{
                    color: localProposal.userVote === -1 ? 'var(--color-error)' : themeTokens.neutral[400],
                  }}
                >
                  {localProposal.userVote === -1 ? (
                    <ThumbDownIcon fontSize="small" />
                  ) : (
                    <ThumbDownOutlinedIcon fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>

              {isAdminOrLeader && (
                <Box sx={{ ml: 'auto', display: 'flex', gap: 0.5 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<CheckIcon />}
                    disabled={loading}
                    onClick={() => handleResolve('approved')}
                    sx={{
                      color: 'var(--color-success)',
                      borderColor: 'var(--color-success)',
                      fontSize: 12,
                      textTransform: 'none',
                    }}
                  >
                    {t('feed:proposalCard.approve')}
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<CloseIcon />}
                    disabled={loading}
                    onClick={() => handleResolve('rejected')}
                    sx={{
                      color: 'var(--color-error)',
                      borderColor: 'var(--color-error)',
                      fontSize: 12,
                      textTransform: 'none',
                    }}
                  >
                    {t('feed:proposalCard.reject')}
                  </Button>
                </Box>
              )}
            </Box>
          )}

          {/* Admin delete for accepted proposals */}
          {isAdminOrLeader && localProposal.status === 'approved' && (
            <Box sx={{ mt: 1.5 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DeleteIcon />}
                disabled={loading}
                onClick={() => setShowDeleteDialog(true)}
                sx={{
                  color: 'var(--color-error)',
                  borderColor: 'var(--color-error)',
                  fontSize: 12,
                  textTransform: 'none',
                }}
              >
                {t('feed:proposalCard.deleteProposal')}
              </Button>
            </Box>
          )}

          {/* Comments toggle */}
          <Box sx={{ mt: 1.5 }}>
            <FeedCommentButton entityType="proposal" entityId={localProposal.uuid} />
          </Box>

          {/* Timestamp */}
          <Typography variant="caption" sx={{ color: themeTokens.neutral[400], mt: 1, display: 'block' }}>
            {new Date(localProposal.createdAt).toLocaleDateString()}
          </Typography>
        </CardContent>
      </Card>

      {/* TODO: Lift delete Dialog to parent (proposal-section/proposal-feed) to avoid N Dialog instances in lists */}
      <Dialog open={showDeleteDialog} onClose={() => setShowDeleteDialog(false)}>
        <DialogTitle>{t('feed:proposalCard.deleteDialog.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('feed:proposalCard.deleteDialog.description')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowDeleteDialog(false)} disabled={loading}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={handleDelete} color="error" disabled={loading}>
            {t('actions.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* TODO: Replace local Snackbar with useSnackbar() from SnackbarProvider */}
      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </>
  );
}
