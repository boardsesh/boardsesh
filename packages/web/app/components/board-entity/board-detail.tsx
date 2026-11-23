'use client';

import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Avatar from '@mui/material/Avatar';
import MuiTypography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Divider from '@mui/material/Divider';
import MuiButton from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import TrendingUpOutlined from '@mui/icons-material/TrendingUpOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import ChatBubbleOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_BOARD,
  DELETE_BOARD,
  FOLLOW_BOARD,
  UNFOLLOW_BOARD,
  LINK_BOARD_TO_GYM,
  type GetBoardQueryResponse,
  type GetBoardQueryVariables,
  type DeleteBoardMutationVariables,
  type DeleteBoardMutationResponse,
  type LinkBoardToGymMutationVariables,
  type LinkBoardToGymMutationResponse,
} from '@boardsesh/graphql/operations';
import { useSession } from 'next-auth/react';
import { themeTokens } from '@/app/theme/theme-config';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import FollowButton from '@/app/components/ui/follow-button';
import BoardLeaderboard from './board-leaderboard';
import EditBoardForm from './edit-board-form';
import type { BoardFormSubmitState } from './board-form';
import CommentSection from '@/app/components/social/comment-section';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import GymDetail from '@/app/components/gym-entity/gym-detail';
import GymSelector from '@/app/components/gym-entity/gym-selector';
import { boardTypeLabel } from '@boardsesh/board-constants';

/**
 * Reported up by BoardDetailContent while the board is being edited, so a
 * titled host drawer can move the edit title + Save action into its header
 * (the bottom-drawer ruling — the iOS keyboard buries a footer). `null` while
 * not editing.
 */
export type BoardDetailEditHost = {
  formId: string;
  title: string;
  submit: BoardFormSubmitState;
  onCancel: () => void;
};

export type BoardDetailContentProps = {
  boardUuid: string;
  /** Override for the initial isFollowedByMe state (e.g. from search results). */
  initialIsFollowing?: boolean;
  onDeleted?: () => void;
  /** Called when follow state changes, so parent can update caches. */
  onFollowChange?: (boardUuid: string, isFollowing: boolean) => void;
  /**
   * When provided (a titled drawer host), the edit form's title and Save action
   * are hosted by the drawer chrome instead of rendered inline. Called with the
   * edit host descriptor while editing, `null` otherwise. Omit for hosts with
   * no header (e.g. the search-result BoardDetail drawer), where the inline
   * title + action bar are kept.
   */
  onEditHostChange?: (host: BoardDetailEditHost | null) => void;
};

export function BoardDetailContent({
  boardUuid,
  initialIsFollowing,
  onDeleted,
  onFollowChange,
  onEditHostChange,
}: BoardDetailContentProps) {
  const { t } = useTranslation('boards');
  const [board, setBoard] = useState<UserBoard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  // Edit-form action hosting: when the host asks for it (onEditHostChange), the
  // drawer header carries the title + Save button and the form submits by id.
  const hostsEditExternally = onEditHostChange != null;
  const editFormId = useId();
  const [editSubmitState, setEditSubmitState] = useState<BoardFormSubmitState>({
    submitLabel: t('editBoard.submitLabel'),
    submitting: false,
    canSubmit: false,
  });
  const handleEditCancel = useCallback(() => setIsEditing(false), []);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showGymDetail, setShowGymDetail] = useState(false);
  const [showGymSelector, setShowGymSelector] = useState(false);
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();
  const currentUserId = session?.user?.id ?? null;

  const fetchBoard = useCallback(async () => {
    if (!token || !boardUuid) return;
    setIsLoading(true);
    try {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<GetBoardQueryResponse, GetBoardQueryVariables>(GET_BOARD, {
        boardUuid,
      });
      const fetchedBoard = data.board ?? null;
      if (fetchedBoard && initialIsFollowing !== undefined) {
        fetchedBoard.isFollowedByMe = initialIsFollowing;
      }
      setBoard(fetchedBoard);
    } catch (error) {
      console.error('Failed to fetch board:', error);
    } finally {
      setIsLoading(false);
    }
  }, [token, boardUuid, initialIsFollowing]);

  useEffect(() => {
    void fetchBoard();
    setIsEditing(false);
    setActiveTab(0);
  }, [fetchBoard]);

  // Report the edit-host descriptor to a titled drawer so it can title the
  // surface + host the Save action. Kept in a ref so the unmount cleanup below
  // can clear a stale header action bar without re-subscribing on identity
  // change.
  const onEditHostChangeRef = useRef(onEditHostChange);
  onEditHostChangeRef.current = onEditHostChange;
  const editTitle = t('editBoard.title');
  useEffect(() => {
    const report = onEditHostChangeRef.current;
    if (!report) return;
    report(
      isEditing ? { formId: editFormId, title: editTitle, submit: editSubmitState, onCancel: handleEditCancel } : null,
    );
  }, [isEditing, editFormId, editTitle, editSubmitState, handleEditCancel]);
  useEffect(() => () => onEditHostChangeRef.current?.(null), []);

  const isOwner = !!currentUserId && board?.ownerId === currentUserId;

  const handleDeleteConfirm = async () => {
    if (!token || !board) return;

    setShowDeleteDialog(false);
    setIsDeleting(true);
    try {
      const client = createGraphQLHttpClient(token);
      await client.request<DeleteBoardMutationResponse, DeleteBoardMutationVariables>(DELETE_BOARD, {
        boardUuid: board.uuid,
      });
      showMessage(t('boardEntity.snackbar.deleted'), 'success');
      onDeleted?.();
    } catch (error) {
      console.error('Failed to delete board:', error);
      showMessage(t('boardEntity.snackbar.deleteFailed'), 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEditSuccess = (updatedBoard: UserBoard) => {
    setBoard(updatedBoard);
    setIsEditing(false);
  };

  const handleLinkGym = async (gymUuid: string | null) => {
    if (!token || !board) return;
    try {
      const client = createGraphQLHttpClient(token);
      await client.request<LinkBoardToGymMutationResponse, LinkBoardToGymMutationVariables>(LINK_BOARD_TO_GYM, {
        input: { boardUuid: board.uuid, gymUuid },
      });
      showMessage(
        gymUuid ? t('boardEntity.snackbar.linkedToGym') : t('boardEntity.snackbar.unlinkedFromGym'),
        'success',
      );
      setShowGymSelector(false);
      void fetchBoard();
    } catch (error) {
      console.error('Failed to link board to gym:', error);
      showMessage(t('boardEntity.snackbar.linkFailed'), 'error');
    }
  };

  const handleFollowChange = useCallback(
    (isFollowing: boolean) => {
      if (board) {
        onFollowChange?.(board.uuid, isFollowing);
      }
      void fetchBoard();
    },
    [board, onFollowChange, fetchBoard],
  );

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!board) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
        <MuiTypography color="text.secondary">{t('boardEntity.notFound')}</MuiTypography>
      </Box>
    );
  }

  if (isEditing) {
    return (
      <Box sx={{ px: 2, pb: 2, overflow: 'auto', flex: 1 }}>
        <EditBoardForm
          board={board}
          onSuccess={handleEditSuccess}
          onCancel={handleEditCancel}
          formId={hostsEditExternally ? editFormId : undefined}
          onSubmitStateChange={hostsEditExternally ? setEditSubmitState : undefined}
        />
      </Box>
    );
  }

  return (
    <>
      {/* Header */}
      <Box sx={{ px: 2, pb: 2 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <MuiTypography variant="h5" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
              {board.name}
            </MuiTypography>
            {board.locationName && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                <LocationOnOutlined sx={{ fontSize: 16, color: 'var(--neutral-400)' }} />
                <MuiTypography variant="body2" color="text.secondary">
                  {board.locationName}
                </MuiTypography>
              </Box>
            )}
          </Box>
          <Chip label={boardTypeLabel(board.boardType)} size="small" variant="outlined" />
        </Box>

        {/* Owner info */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
          <Avatar src={board.ownerAvatarUrl ?? undefined} sx={{ width: 24, height: 24, fontSize: 11 }}>
            {board.ownerDisplayName?.[0]?.toUpperCase()}
          </Avatar>
          <MuiTypography variant="body2" color="text.secondary">
            {board.ownerDisplayName}
          </MuiTypography>
        </Box>

        {board.description && (
          <MuiTypography variant="body2" sx={{ mt: 1.5, color: 'var(--neutral-600)' }}>
            {board.description}
          </MuiTypography>
        )}

        {isOwner && (board.isUnlisted || board.hideLocation) && (
          <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
            {board.isUnlisted && (
              <Chip label={t('boardEntity.chips.unlisted')} size="small" variant="outlined" color="warning" />
            )}
            {board.hideLocation && (
              <Chip label={t('boardEntity.chips.locationHidden')} size="small" variant="outlined" color="warning" />
            )}
          </Box>
        )}

        {/* Gym info */}
        {board.gymName && board.gymUuid && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mt: 1.5,
              cursor: 'pointer',
              '&:hover': { opacity: 0.8 },
            }}
            onClick={() => setShowGymDetail(true)}
          >
            <FitnessCenterOutlined sx={{ fontSize: 16, color: 'var(--neutral-400)' }} />
            <MuiTypography variant="body2" color="primary" sx={{ textDecoration: 'underline' }}>
              {board.gymName}
            </MuiTypography>
          </Box>
        )}
        {!board.gymUuid && isOwner && !showGymSelector && (
          <MuiButton
            variant="text"
            size="small"
            startIcon={<AddOutlined />}
            onClick={() => setShowGymSelector(true)}
            sx={{ textTransform: 'none', mt: 1, alignSelf: 'flex-start' }}
          >
            {t('boardEntity.actions.addToGym')}
          </MuiButton>
        )}
        {showGymSelector && isOwner && (
          <Box sx={{ mt: 1.5 }}>
            <GymSelector selectedGymUuid={board.gymUuid ?? null} onSelect={(gymUuid) => handleLinkGym(gymUuid)} />
          </Box>
        )}

        {/* Stats */}
        <Box sx={{ display: 'flex', gap: 2.5, mt: 2, flexWrap: 'wrap' }}>
          <StatChip
            icon={<TrendingUpOutlined sx={{ fontSize: 16 }} />}
            value={board.totalAscents}
            label={t('boardEntity.stats.ascents')}
          />
          <StatChip
            icon={<PersonOutlined sx={{ fontSize: 16 }} />}
            value={board.uniqueClimbers}
            label={t('boardEntity.stats.climbers')}
          />
          <StatChip
            icon={<PeopleOutlined sx={{ fontSize: 16 }} />}
            value={board.followerCount}
            label={t('boardEntity.stats.followers')}
          />
          <StatChip
            icon={<ChatBubbleOutlined sx={{ fontSize: 16 }} />}
            value={board.commentCount}
            label={t('boardEntity.stats.comments')}
          />
        </Box>

        {/* Actions */}
        {board.isPublic && board.boardType !== 'spray' && (
          <MuiButton
            component={LocaleLink}
            href={`/moderation/board-merges?boardUuid=${encodeURIComponent(board.uuid)}`}
          >
            {t('merge.report')}
          </MuiButton>
        )}
        <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
          {!isOwner && (
            <FollowButton
              entityId={board.uuid}
              initialIsFollowing={board.isFollowedByMe}
              followMutation={FOLLOW_BOARD}
              unfollowMutation={UNFOLLOW_BOARD}
              entityLabel={t('boardEntity.follow.entityLabel')}
              getFollowVariables={(id) => ({ input: { boardUuid: id } })}
              onFollowChange={handleFollowChange}
            />
          )}
          {board.canEdit && (
            <MuiButton
              variant="outlined"
              size="small"
              startIcon={<EditOutlined />}
              onClick={() => setIsEditing(true)}
              sx={{ textTransform: 'none' }}
            >
              {t('boardEntity.actions.edit')}
            </MuiButton>
          )}
          {isOwner && (
            <MuiButton
              variant="outlined"
              size="small"
              color="error"
              startIcon={<DeleteOutlined />}
              onClick={() => setShowDeleteDialog(true)}
              disabled={isDeleting}
              sx={{ textTransform: 'none' }}
            >
              {isDeleting ? <CircularProgress size={16} /> : t('boardEntity.actions.delete')}
            </MuiButton>
          )}
        </Box>
      </Box>

      <Divider />

      {/* Tabs */}
      <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} sx={{ px: 2 }}>
        <Tab label={t('boardEntity.tabs.leaderboard')} sx={{ textTransform: 'none' }} />
        <Tab label={t('boardEntity.tabs.comments')} sx={{ textTransform: 'none' }} />
      </Tabs>

      {/* Tab content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 2 }}>
        {activeTab === 0 && <BoardLeaderboard boardUuid={board.uuid} />}
        {activeTab === 1 && (
          <CommentSection entityType="board" entityId={board.uuid} title={t('boardEntity.comments.title')} />
        )}
      </Box>

      {/* Gym detail drawer */}
      {board.gymUuid && (
        <GymDetail gymUuid={board.gymUuid} open={showGymDetail} onClose={() => setShowGymDetail(false)} anchor="top" />
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteDialog} onClose={() => setShowDeleteDialog(false)}>
        <DialogTitle>{t('boardEntity.delete.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('boardEntity.delete.confirm', { name: board.name })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <MuiButton onClick={() => setShowDeleteDialog(false)}>{t('boardEntity.delete.cancel')}</MuiButton>
          <MuiButton onClick={handleDeleteConfirm} color="error" autoFocus>
            {t('boardEntity.delete.delete')}
          </MuiButton>
        </DialogActions>
      </Dialog>
    </>
  );
}

type BoardDetailProps = {
  boardUuid: string;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
  anchor?: 'top' | 'bottom';
};

export default function BoardDetail({ boardUuid, open, onClose, onDeleted, anchor = 'bottom' }: BoardDetailProps) {
  return (
    <SwipeableDrawer
      placement={anchor}
      open={open}
      onClose={onClose}
      height="90dvh"
      styles={{ body: { padding: 0, overflow: 'hidden' } }}
    >
      {open && (
        <BoardDetailContent
          boardUuid={boardUuid}
          onDeleted={() => {
            onDeleted?.();
            onClose();
          }}
        />
      )}
    </SwipeableDrawer>
  );
}

function StatChip({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Box sx={{ color: 'var(--neutral-400)', display: 'flex' }}>{icon}</Box>
      <MuiTypography variant="body2" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
        {value}
      </MuiTypography>
      <MuiTypography variant="body2" color="text.secondary">
        {label}
      </MuiTypography>
    </Box>
  );
}
