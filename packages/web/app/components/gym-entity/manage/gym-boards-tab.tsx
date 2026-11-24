'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Divider from '@mui/material/Divider';
import type { TFunction } from 'i18next';
import AddOutlined from '@mui/icons-material/AddOutlined';
import LinkOffOutlined from '@mui/icons-material/LinkOffOutlined';
import AddLinkOutlined from '@mui/icons-material/AddLinkOutlined';
import PrintOutlined from '@mui/icons-material/PrintOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import {
  GET_GYM,
  GET_GYM_BOARDS_FOR_MANAGE,
  GET_MY_BOARDS,
  DELETE_BOARD,
  LINK_BOARD_TO_GYM,
  DETACH_BOARD_FROM_GYM,
  STRAY_BOARDS_FOR_GYM,
  ATTACH_BOARD_TO_GYM,
  type GetGymBoardsForManageQueryResponse,
  type GetGymBoardsForManageQueryVariables,
  type GetGymQueryResponse,
  type GetGymQueryVariables,
  type DeleteBoardMutationResponse,
  type DeleteBoardMutationVariables,
  type GetMyBoardsQueryResponse,
  type LinkBoardToGymMutationResponse,
  type LinkBoardToGymMutationVariables,
  type DetachBoardFromGymMutationResponse,
  type DetachBoardFromGymMutationVariables,
  type StrayBoardsForGymQueryResponse,
  type StrayBoardsForGymQueryVariables,
  type AttachBoardToGymMutationResponse,
  type AttachBoardToGymMutationVariables,
} from '@boardsesh/graphql/operations';
import { retireGymReportingReceiptsForGym } from '@boardsesh/graphql';
import { boardOriginFor, type StrayBoard, type UserBoard } from '@boardsesh/shared-schema';
import { isBoardRemovedByGymError, isSystemBoardDeleteInsteadError } from '@boardsesh/graphql/errors';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { themeTokens } from '@/app/theme/theme-config';
import LocaleLink from '@/app/components/i18n/locale-link';
import { boardPosterConsoleHref } from '@/app/lib/board-poster';
import { canManageGymBoards, linkableBoards } from './gym-board-permissions';
import ConfirmDialog from './confirm-dialog';
import type { GymManageTabProps } from './tab-props';
import GymBoardEditor from './gym-board-editor';
import BoardReportReviewDialog from './board-report-review-dialog';
import { hasOpenReports, sortBoardsReportedFirst } from './report-review-logic';

export function VisibilityChip({ board }: { board: Pick<UserBoard, 'isPublic' | 'isUnlisted'> }) {
  const { t } = useTranslation('kiosk');
  if (board.isUnlisted) {
    return <Chip size="small" color="warning" variant="outlined" label={t('manage.boards.visibility.unlisted')} />;
  }
  if (board.isPublic) {
    return <Chip size="small" color="success" variant="outlined" label={t('manage.boards.visibility.public')} />;
  }
  return <Chip size="small" variant="outlined" label={t('manage.boards.visibility.private')} />;
}

/**
 * Where a board came from, as the row says it: "Added by you", "Added by Sam",
 * "Added by a climber" (their privacy keeps the name back) or "From public
 * board data". Static-literal keys: the i18n linter forbids t(variable).
 */
function boardOriginLabel(board: UserBoard, viewerUserId: string | null, t: TFunction<'boards'>): string {
  switch (boardOriginFor(board, viewerUserId)) {
    case 'own':
      return t('boardOrigin.addedByYou');
    case 'synced':
      return t('boardOrigin.synced');
    case 'climber':
      return t('boardOrigin.addedBy', { name: board.ownerDisplayName ?? '' });
    case 'hidden':
      return t('boardOrigin.addedByHidden');
  }
}

/** The delete confirm's body: for everyone, and logged sends are kept. */
function deleteBody(board: UserBoard, viewerUserId: string | null, t: TFunction<'boards'>): string {
  switch (boardOriginFor(board, viewerUserId)) {
    case 'own':
      return t('gymBoards.deleteBodyOwn');
    case 'synced':
      return t('gymBoards.deleteBodySynced');
    case 'climber':
      return t('gymBoards.deleteBodyOther', { name: board.ownerDisplayName ?? '' });
    case 'hidden':
      return t('gymBoards.deleteBodyOtherHidden');
  }
}

/** The Remove from gym confirm's body: where it comes off, and who keeps it. */
function removeBody(board: UserBoard, gymName: string, viewerUserId: string | null, t: TFunction<'boards'>): string {
  switch (boardOriginFor(board, viewerUserId)) {
    case 'own':
      return t('gymBoards.removeBodyOwn', { gym: gymName });
    case 'synced':
      return t('gymBoards.removeBodySynced', { gym: gymName });
    case 'climber':
      return t('gymBoards.removeBodyOther', { name: board.ownerDisplayName ?? '', gym: gymName });
    case 'hidden':
      return t('gymBoards.removeBodyOtherHidden', { gym: gymName });
  }
}

export default function GymBoardsTab({ gym, onGymChange, onDirtyChange }: GymManageTabProps) {
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const viewerUserId = session?.user?.id ?? null;
  const refreshContextRef = useRef({ gymUuid: gym.uuid, viewerUserId });
  const isMountedRef = useRef(true);
  if (refreshContextRef.current.gymUuid !== gym.uuid || refreshContextRef.current.viewerUserId !== viewerUserId) {
    refreshContextRef.current = { gymUuid: gym.uuid, viewerUserId };
  }

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshContext = refreshContextRef.current;
  const refreshGym = async () => {
    if (!token || !isMountedRef.current || refreshContextRef.current !== refreshContext) return;
    try {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetGymQueryResponse, GetGymQueryVariables>(GET_GYM, { gymUuid: gym.uuid });
      if (isMountedRef.current && refreshContextRef.current === refreshContext && response.gym)
        onGymChange(response.gym);
    } catch (error) {
      console.error('Failed to refresh gym after board change:', error);
    }
  };

  return (
    <GymBoardAssociation
      key={`${gym.uuid}:${viewerUserId ?? ''}`}
      gym={gym}
      onDirtyChange={onDirtyChange}
      onAssociated={refreshGym}
      allowDelete
    />
  );
}

/** Shared by initial gym setup and the management console. */
export function GymBoardAssociation({
  gym,
  onAssociated,
  onDirtyChange,
  allowDelete = false,
}: {
  gym: GymManageTabProps['gym'];
  onAssociated?: () => Promise<void>;
  onDirtyChange?: (isDirty: boolean) => void;
  allowDelete?: boolean;
}) {
  const { t } = useTranslation('kiosk');
  const { t: tGyms } = useTranslation('gyms');
  const { t: tBoards } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();
  const router = useLocaleRouter();
  const viewerUserId = session?.user?.id ?? null;
  const queryClient = useQueryClient();
  const [boards, setBoards] = useState<UserBoard[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<UserBoard | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserBoard | null>(null);
  const [deletingBoardUuid, setDeletingBoardUuid] = useState<string | null>(null);
  const [removingBoardUuid, setRemovingBoardUuid] = useState<string | null>(null);
  const deletionPendingRef = useRef(false);
  const removalPendingRef = useRef(false);
  const isMountedRef = useRef(true);
  const boardRequestGenerationRef = useRef(0);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingBoardUuid, setEditingBoardUuid] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<UserBoard | null>(null);
  // Reported boards first, so the ones climbers flagged are the first thing staff see.
  const orderedBoards = useMemo(() => sortBoardsReportedFirst(boards ?? []), [boards]);
  const linkedBoardUuids = useMemo(() => new Set((boards ?? []).map((board) => board.uuid)), [boards]);
  // Linking your own board needs gym owner/admin. Which board offers Remove
  // from gym and Delete is the server's call (`canRemoveFromGym`, `canDelete`),
  // never rebuilt here: a gym's staff can take any board off their listing, but
  // only delete the synced ones (docs/product/gym-board-governance.md).
  const canLinkBoards = canManageGymBoards(gym, viewerUserId);
  const actionPending = deletingBoardUuid !== null || removingBoardUuid !== null;

  const linkMutation = useEntityMutation<LinkBoardToGymMutationResponse, LinkBoardToGymMutationVariables>(
    LINK_BOARD_TO_GYM,
    {
      successMessage: t('manage.boards.linked'),
      errorMessage: t('manage.boards.linkFailed'),
      // A board this gym's staff took off the listing can't be self-linked
      // back. Staff linking their own board never meets it, but say it plainly
      // if the server ever does rather than show its English. Any other code
      // gets the translated failure, never the server's raw message.
      onError: (error) =>
        showMessage(
          isBoardRemovedByGymError(error) ? tBoards('gymBoards.removedByGymError') : t('manage.boards.linkFailed'),
          'error',
        ),
    },
  );
  // Remove from gym has two mutations behind one button. The board's creator
  // unlinks it (LINK_BOARD_TO_GYM, gym null); anyone else is staff, whose
  // removal also stops the creator linking it straight back.
  const unlinkMutation = useEntityMutation<LinkBoardToGymMutationResponse, LinkBoardToGymMutationVariables>(
    LINK_BOARD_TO_GYM,
    {
      successMessage: tBoards('gymBoards.removed', { gym: gym.name }),
      errorMessage: tBoards('gymBoards.removeFailed'),
    },
  );
  const detachMutation = useEntityMutation<DetachBoardFromGymMutationResponse, DetachBoardFromGymMutationVariables>(
    DETACH_BOARD_FROM_GYM,
    {
      successMessage: tBoards('gymBoards.removed', { gym: gym.name }),
      errorMessage: tBoards('gymBoards.removeFailed'),
      // A synced board is deleted, not removed: the server says so by code.
      onError: (error) =>
        showMessage(
          isSystemBoardDeleteInsteadError(error)
            ? tBoards('gymBoards.removeSyncedError')
            : tBoards('gymBoards.removeFailed'),
          'error',
        ),
    },
  );
  const deleteMutation = useEntityMutation<DeleteBoardMutationResponse, DeleteBoardMutationVariables>(DELETE_BOARD, {
    errorMessage: tBoards('boardEntity.snackbar.deleteFailed'),
  });

  const fetchBoards = useCallback(async () => {
    const requestGeneration = ++boardRequestGenerationRef.current;
    if (!token) return;
    setLoadError(false);
    try {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<GetGymBoardsForManageQueryResponse, GetGymBoardsForManageQueryVariables>(
        GET_GYM_BOARDS_FOR_MANAGE,
        { gymUuid: gym.uuid },
      );
      if (requestGeneration !== boardRequestGenerationRef.current || !isMountedRef.current) return;
      setBoards(data.gymBoards ?? []);
    } catch (error) {
      if (requestGeneration !== boardRequestGenerationRef.current || !isMountedRef.current) return;
      console.error('Failed to load gym boards:', error);
      setLoadError(true);
      setBoards([]);
    }
  }, [token, gym.uuid]);

  useEffect(() => {
    void fetchBoards();
    return () => {
      boardRequestGenerationRef.current += 1;
    };
  }, [fetchBoards]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleRemoveConfirm = async () => {
    if (!removeTarget || removalPendingRef.current || removeTarget.canRemoveFromGym !== true) return;
    const target = removeTarget;
    removalPendingRef.current = true;
    setRemovingBoardUuid(target.uuid);
    setRemoveTarget(null);
    try {
      const removed =
        boardOriginFor(target, viewerUserId) === 'own'
          ? (await unlinkMutation.execute({ input: { boardUuid: target.uuid, gymUuid: null } }))?.linkBoardToGym
          : (await detachMutation.execute({ input: { gymUuid: gym.uuid, boardUuid: target.uuid } }))
              ?.detachBoardFromGym;
      if (!removed) return;
      void retireGymReportingReceiptsForGym(queryClient, gym.uuid);
      if (!isMountedRef.current) return;
      setBoards((previous) => previous?.filter((board) => board.uuid !== target.uuid) ?? null);
      // The public gym page and kiosks read the listing on the server.
      router.refresh();
      await fetchBoards();
      if (isMountedRef.current) await onAssociated?.();
    } finally {
      removalPendingRef.current = false;
      if (isMountedRef.current) setRemovingBoardUuid(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!allowDelete || !deleteTarget || deletionPendingRef.current || deleteTarget.canDelete !== true) return;
    const target = deleteTarget;
    deletionPendingRef.current = true;
    setDeletingBoardUuid(target.uuid);
    setDeleteTarget(null);
    try {
      const response = await deleteMutation.execute({ boardUuid: target.uuid });
      if (!isMountedRef.current) return;
      if (!response?.deleteBoard) {
        if (response) showMessage(tBoards('boardEntity.snackbar.deleteFailed'), 'error');
        return;
      }
      setBoards((previous) => previous?.filter((board) => board.uuid !== target.uuid) ?? null);
      showMessage(tBoards('boardEntity.snackbar.deleted'), 'success');
      router.refresh();
      await fetchBoards();
      if (isMountedRef.current) await onAssociated?.();
    } finally {
      deletionPendingRef.current = false;
      if (isMountedRef.current) setDeletingBoardUuid(null);
    }
  };

  // Returns whether the link succeeded so the dialog only drops the candidate
  // on an actual success (useEntityMutation resolves null on failure).
  const handleLink = async (boardUuid: string): Promise<boolean> => {
    const result = await linkMutation.execute({ input: { boardUuid, gymUuid: gym.uuid } });
    if (result) {
      await fetchBoards();
      await onAssociated?.();
      return true;
    }
    return false;
  };

  if (editingBoardUuid) {
    return (
      <GymBoardEditor
        key={editingBoardUuid}
        boardUuid={editingBoardUuid}
        onDirtyChange={onDirtyChange}
        onBack={() => setEditingBoardUuid(null)}
        onSaved={(updatedBoard) => {
          setBoards(
            (previous) => previous?.map((board) => (board.uuid === updatedBoard.uuid ? updatedBoard : board)) ?? null,
          );
          setEditingBoardUuid(null);
          void fetchBoards();
          void onAssociated?.();
        }}
      />
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
            {t('manage.boards.heading')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t('manage.boards.description')}
          </Typography>
        </Box>
        {canLinkBoards && (
          <Button
            variant="contained"
            size="small"
            startIcon={<AddOutlined />}
            onClick={() => setAddDialogOpen(true)}
            sx={{ textTransform: 'none', flexShrink: 0 }}
          >
            {t('manage.boards.addBoard')}
          </Button>
        )}
      </Box>
      {/* Editors (and community roles without a gym seat) can remove boards
          and add the ones near the gym, but not link their own or delete. */}
      {!canLinkBoards && !boards?.some((board) => board.canDelete === true) && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {t('manage.boards.readOnlyHint')}
        </Typography>
      )}

      {(gym.latitude == null || gym.longitude == null) && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {tGyms('create.locationMissing')}
        </Typography>
      )}

      {boards === null ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : loadError ? (
        <Box sx={{ py: 2 }}>
          <Typography variant="body2" color="error">
            {t('manage.boards.loadError')}
          </Typography>
          <Button onClick={() => void fetchBoards()}>{tGyms('create.retry')}</Button>
        </Box>
      ) : boards.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {t('manage.boards.empty')}
        </Typography>
      ) : (
        <List disablePadding>
          {orderedBoards.map((board) => (
            <ListItem
              key={board.uuid}
              divider
              disableGutters
              secondaryAction={
                // Not red: the board stays with whoever added it, and staff can
                // put it back.
                board.canRemoveFromGym === true ? (
                  <Button
                    size="small"
                    startIcon={<LinkOffOutlined />}
                    onClick={() => setRemoveTarget(board)}
                    disabled={actionPending}
                    loading={removingBoardUuid === board.uuid}
                    sx={{ textTransform: 'none' }}
                  >
                    {tBoards('gymBoards.remove')}
                  </Button>
                ) : null
              }
            >
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography component="span" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                      {board.name}
                    </Typography>
                    <VisibilityChip board={board} />
                    {hasOpenReports(board) && (
                      <>
                        <Chip size="small" color="warning" label={tBoards('reportReview.statusPill')} />
                        <Button
                          size="small"
                          startIcon={<FlagOutlined />}
                          onClick={() => setReviewTarget(board)}
                          disabled={actionPending}
                          sx={{ textTransform: 'none' }}
                        >
                          {tBoards('reportReview.review')}
                        </Button>
                      </>
                    )}
                    {board.canEdit && (
                      <Button
                        size="small"
                        startIcon={<EditOutlined />}
                        onClick={() => setEditingBoardUuid(board.uuid)}
                        disabled={actionPending}
                        sx={{ textTransform: 'none' }}
                      >
                        {tBoards('boardEntity.actions.edit')}
                      </Button>
                    )}
                    {/* In the wrapping title row, not beside Remove from gym: two
                        actions in the fixed-width secondary slot would run over
                        the board's name on a phone. */}
                    <BoardPosterAction board={board} />
                    {allowDelete && board.canDelete === true && (
                      <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteOutlined />}
                        onClick={() => setDeleteTarget(board)}
                        disabled={actionPending}
                        loading={deletingBoardUuid === board.uuid}
                        sx={{ textTransform: 'none' }}
                      >
                        {tBoards('boardEntity.actions.delete')}
                      </Button>
                    )}
                  </Box>
                }
                secondary={
                  <>
                    <Box component="span" sx={{ display: 'block' }}>
                      {`${boardTypeLabel(board.boardType)} · ${board.angle}°`}
                    </Box>
                    <Box component="span" sx={{ display: 'block' }}>
                      {boardOriginLabel(board, viewerUserId, tBoards)}
                    </Box>
                    {/* A synced board with no action for this viewer: say who can. */}
                    {boardOriginFor(board, viewerUserId) === 'synced' &&
                      board.canRemoveFromGym !== true &&
                      board.canDelete !== true && (
                        <Box component="span" sx={{ display: 'block' }}>
                          {t('manage.boards.askAdminToDelete')}
                        </Box>
                      )}
                  </>
                }
              />
            </ListItem>
          ))}
        </List>
      )}

      {gym.canEdit && (
        <StrayBoardsSection
          gymUuid={gym.uuid}
          onAttached={async () => {
            await fetchBoards();
            await onAssociated?.();
          }}
        />
      )}

      <BoardReportReviewDialog
        // A fresh dialog per board, so one board's reports never show under another's name.
        key={reviewTarget?.uuid ?? 'closed'}
        board={reviewTarget}
        gymName={gym.name}
        onClose={() => setReviewTarget(null)}
        onFix={(board) => {
          setReviewTarget(null);
          setEditingBoardUuid(board.uuid);
        }}
        onRemove={(board) => {
          setReviewTarget(null);
          setRemoveTarget(board);
        }}
        onDelete={(board) => {
          setReviewTarget(null);
          setDeleteTarget(board);
        }}
        allowDelete={allowDelete}
        onResolved={() => void fetchBoards()}
      />

      {/* "For everyone", and logged sends are kept: delete takes the board
          from every climber who saved it. */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={tBoards('gymBoards.deleteTitle', { board: deleteTarget?.name ?? '' })}
        body={deleteTarget ? deleteBody(deleteTarget, viewerUserId, tBoards) : ''}
        confirmLabel={tBoards('gymBoards.deleteConfirm')}
        cancelLabel={tBoards('gymBoards.cancel')}
        onConfirm={() => void handleDeleteConfirm()}
        onClose={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title={tBoards('gymBoards.removeTitle', { board: removeTarget?.name ?? '', gym: gym.name })}
        body={removeTarget ? removeBody(removeTarget, gym.name, viewerUserId, tBoards) : ''}
        confirmLabel={tBoards('gymBoards.removeConfirm')}
        cancelLabel={tBoards('gymBoards.cancel')}
        confirmColor="primary"
        onConfirm={() => void handleRemoveConfirm()}
        onClose={() => setRemoveTarget(null)}
      />

      {canLinkBoards && (
        <AddBoardDialog
          open={addDialogOpen}
          gymUuid={gym.uuid}
          viewerUserId={viewerUserId}
          linkedBoardUuids={linkedBoardUuids}
          onClose={() => setAddDialogOpen(false)}
          onLink={handleLink}
        />
      )}
    </Box>
  );
}

/**
 * "Print poster" for one board row (#4415), or nothing when the board gets no
 * poster: a private Spraywall, a Spraywall with no slug yet, or an LED board
 * that is Followers, Invite-only or Only me. `boardPosterConsoleHref` applies
 * the poster page's own rule, so the console never offers a link that 404s for
 * a reason it could have known.
 */
function BoardPosterAction({ board }: { board: UserBoard }) {
  const { t } = useTranslation('kiosk');
  const posterHref = boardPosterConsoleHref(board);
  if (!posterHref) return null;
  return (
    <Button
      size="small"
      component={LocaleLink}
      href={posterHref}
      startIcon={<PrintOutlined />}
      sx={{ textTransform: 'none' }}
    >
      {t('manage.boards.printPoster')}
    </Button>
  );
}

type AddBoardDialogProps = {
  open: boolean;
  gymUuid: string;
  viewerUserId: string | null;
  linkedBoardUuids: Set<string>;
  onClose: () => void;
  /** Resolves true when the link mutation succeeded. */
  onLink: (boardUuid: string) => Promise<boolean>;
};

function AddBoardDialog({ open, gymUuid, viewerUserId, linkedBoardUuids, onClose, onLink }: AddBoardDialogProps) {
  const { t } = useTranslation('kiosk');
  const { t: tGyms } = useTranslation('gyms');
  const { token } = useWsAuthToken();
  const [candidates, setCandidates] = useState<UserBoard[] | null>(null);
  const [linkingUuid, setLinkingUuid] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestVersionRef = useRef(0);
  const loadingRef = useRef(false);

  // The candidates fetch runs once per dialog open. `linkedBoardUuids` changes
  // after every successful link (the parent refetches gymBoards), so reading it
  // through a ref keeps it out of the effect deps — otherwise each link would
  // re-fetch myBoards and blank the open dialog behind a spinner. While the
  // dialog is open the list is maintained optimistically in handleLinkClick.
  const linkedBoardUuidsRef = useRef(linkedBoardUuids);
  useEffect(() => {
    linkedBoardUuidsRef.current = linkedBoardUuids;
  }, [linkedBoardUuids]);

  const fetchPage = useCallback(
    async (offset: number, append: boolean, requestVersion: number) => {
      if (!token || loadingRef.current) return;
      loadingRef.current = true;
      setLoadingMore(append);
      setLoadError(false);
      try {
        const client = createGraphQLHttpClient(token);
        const response = await client.request<GetMyBoardsQueryResponse>(GET_MY_BOARDS, {
          input: { limit: 50, offset },
        });
        if (requestVersionRef.current !== requestVersion) return;
        // ownerId, not isOwned — myBoards includes followed boards, and isOwned
        // is the physical-ownership column, not the account that may link it.
        const available = linkableBoards(response.myBoards.boards, gymUuid, linkedBoardUuidsRef.current, viewerUserId);
        setCandidates((previous) => {
          const combined = append ? [...(previous ?? []), ...available] : available;
          return [...new Map(combined.map((board) => [board.uuid, board])).values()];
        });
        setHasMore(response.myBoards.hasMore);
        setNextOffset(offset + response.myBoards.boards.length);
      } catch (error) {
        console.error('Failed to load your boards:', error);
        if (requestVersionRef.current === requestVersion) {
          setLoadError(true);
          if (!append) setCandidates([]);
        }
      } finally {
        if (requestVersionRef.current === requestVersion) {
          loadingRef.current = false;
          setLoadingMore(false);
        }
      }
    },
    [token, gymUuid, viewerUserId],
  );

  useEffect(() => {
    requestVersionRef.current += 1;
    loadingRef.current = false;
    if (!open || !token) return;
    setCandidates(null);
    setHasMore(false);
    setNextOffset(0);
    void fetchPage(0, false, requestVersionRef.current);
    return () => {
      requestVersionRef.current += 1;
      loadingRef.current = false;
    };
  }, [open, token, fetchPage]);

  const handleLinkClick = async (boardUuid: string) => {
    setLinkingUuid(boardUuid);
    try {
      const linked = await onLink(boardUuid);
      // Keep the candidate on failure so the user can retry without reopening.
      if (linked) {
        setCandidates((prev) => (prev === null ? prev : prev.filter((board) => board.uuid !== boardUuid)));
      }
    } finally {
      setLinkingUuid(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t('manage.boards.addDialog.title')}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 1 }}>{t('manage.boards.addDialog.body')}</DialogContentText>
        {loadError && (
          <Box sx={{ py: 1 }}>
            <Typography color="error" variant="body2">
              {tGyms('create.loadError')}
            </Typography>
            <Button onClick={() => void fetchPage(nextOffset, nextOffset > 0, requestVersionRef.current)}>
              {tGyms('create.retry')}
            </Button>
          </Box>
        )}
        {candidates === null ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              {t('manage.boards.addDialog.loading')}
            </Typography>
          </Box>
        ) : candidates.length === 0 && !loadError && !hasMore ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            {t('manage.boards.addDialog.empty')}
          </Typography>
        ) : (
          <List disablePadding>
            {candidates.map((board) => (
              <ListItem
                key={board.uuid}
                disableGutters
                secondaryAction={
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={linkingUuid !== null}
                    onClick={() => handleLinkClick(board.uuid)}
                    sx={{ textTransform: 'none' }}
                  >
                    {linkingUuid === board.uuid ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      t('manage.boards.addDialog.link')
                    )}
                  </Button>
                }
              >
                <ListItemText primary={board.name} secondary={`${boardTypeLabel(board.boardType)} · ${board.angle}°`} />
              </ListItem>
            ))}
          </List>
        )}
        {hasMore && !loadError && (
          <Button disabled={loadingMore} onClick={() => void fetchPage(nextOffset, true, requestVersionRef.current)}>
            {loadingMore ? <CircularProgress size={16} /> : tGyms('create.loadMore')}
          </Button>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>
          {t('manage.boards.addDialog.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type StrayBoardsSectionProps = {
  gymUuid: string;
  /** Called after a successful attach so the linked-boards list refetches. */
  onAttached: () => Promise<void> | void;
};

/**
 * "Boards near your gym": candidates the backend surfaces as physically at
 * this gym (within ~150 m, unlinked or on a synced listing) or left behind by a
 * merged listing. One tap re-points the board to this gym. Only mounted for
 * viewers with gym edit access — the resolver enforces the same gate.
 *
 * A board flagged `isLastBoardAtCurrentGym` is the exception to one-tap: taking
 * it empties its listing, and the backend then folds that listing into this gym,
 * so the consequence gets a confirm step instead of happening silently.
 */
function StrayBoardsSection({ gymUuid, onAttached }: StrayBoardsSectionProps) {
  const { t } = useTranslation('kiosk');
  const { t: tGyms } = useTranslation('gyms');
  const { token } = useWsAuthToken();
  const [strays, setStrays] = useState<StrayBoard[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attachingUuid, setAttachingUuid] = useState<string | null>(null);
  const [mergeConfirmTarget, setMergeConfirmTarget] = useState<StrayBoard | null>(null);

  const attachMutation = useEntityMutation<AttachBoardToGymMutationResponse, AttachBoardToGymMutationVariables>(
    ATTACH_BOARD_TO_GYM,
    { successMessage: t('manage.boards.strays.attached'), errorMessage: t('manage.boards.strays.attachFailed') },
  );

  const fetchStrays = useCallback(async () => {
    if (!token) return;
    setLoadError(false);
    try {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<StrayBoardsForGymQueryResponse, StrayBoardsForGymQueryVariables>(
        STRAY_BOARDS_FOR_GYM,
        { gymUuid },
      );
      setStrays(data.strayBoardsForGym ?? []);
    } catch (error) {
      console.error('Failed to load stray boards:', error);
      setLoadError(true);
      setStrays(null);
    }
  }, [token, gymUuid]);

  useEffect(() => {
    void fetchStrays();
  }, [fetchStrays]);

  const handleAttach = useCallback(
    async (board: StrayBoard, allowSourceGymMerge = false) => {
      setAttachingUuid(board.uuid);
      try {
        const result = await attachMutation.execute({
          input: {
            gymUuid,
            boardUuid: board.uuid,
            expectedCurrentGymUuid: board.currentGymUuid ?? null,
            allowSourceGymMerge,
          },
        });
        if (result) {
          // Drop the attached candidate and pull it into the linked list above.
          setStrays((prev) => (prev === null ? prev : prev.filter((candidate) => candidate.uuid !== board.uuid)));
          await onAttached();
        }
      } finally {
        setAttachingUuid(null);
      }
    },
    [attachMutation, gymUuid, onAttached],
  );

  const handleAttachClick = useCallback(
    (board: StrayBoard) => {
      if (board.currentGymUuid) {
        setMergeConfirmTarget(board);
        return;
      }
      void handleAttach(board);
    },
    [handleAttach],
  );

  const handleMergeConfirm = useCallback(() => {
    const board = mergeConfirmTarget;
    setMergeConfirmTarget(null);
    if (board) {
      void handleAttach(board, true);
    }
  }, [mergeConfirmTarget, handleAttach]);

  const reasonText = (board: StrayBoard): string => {
    if (board.reason === 'MERGED_TWIN') {
      return t('manage.boards.strays.reasonMerged');
    }
    if (board.distanceMeters == null) {
      return t('manage.boards.strays.reasonNearbyGeneric');
    }
    return t('manage.boards.strays.reasonNearby', { meters: Math.round(board.distanceMeters) });
  };

  // Nothing loaded yet: while the first fetch is in flight, render nothing so the
  // section doesn't flash. If that fetch failed, show the heading with an error +
  // retry so a gym owner knows the check didn't run (rather than silently vanish).
  if (strays === null) {
    if (!loadError) {
      return null;
    }
    return (
      <Box sx={{ mt: 4 }}>
        <Divider sx={{ mb: 2 }} />
        <Typography variant="h6" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
          {t('manage.boards.strays.heading')}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
          <Typography variant="body2" color="error">
            {t('manage.boards.strays.loadError')}
          </Typography>
          <Button size="small" onClick={() => void fetchStrays()} sx={{ textTransform: 'none' }}>
            {t('manage.boards.strays.retry')}
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 4 }}>
      <Divider sx={{ mb: 2 }} />
      <Typography variant="h6" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
        {t('manage.boards.strays.heading')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('manage.boards.strays.description')}
      </Typography>

      {strays.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {t('manage.boards.strays.empty')}
        </Typography>
      ) : (
        <List disablePadding>
          {strays.map((board) => (
            <ListItem
              key={board.uuid}
              divider
              disableGutters
              secondaryAction={
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<AddLinkOutlined />}
                  disabled={attachingUuid !== null}
                  onClick={() => handleAttachClick(board)}
                  sx={{ textTransform: 'none' }}
                >
                  {attachingUuid === board.uuid ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : (
                    t('manage.boards.strays.attach')
                  )}
                </Button>
              }
            >
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography component="span">{board.name}</Typography>
                    {board.isLastBoardAtCurrentGym && (
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label={t('manage.boards.strays.lastBoardNote')}
                      />
                    )}
                  </Box>
                }
                secondary={
                  board.currentGymName
                    ? `${boardTypeLabel(board.boardType)} · ${board.angle}° · ${reasonText(board)} · ${t('manage.boards.strays.onListing', { name: board.currentGymName })}`
                    : `${boardTypeLabel(board.boardType)} · ${board.angle}° · ${reasonText(board)}`
                }
              />
            </ListItem>
          ))}
        </List>
      )}

      <ConfirmDialog
        open={mergeConfirmTarget !== null}
        title={
          mergeConfirmTarget?.isLastBoardAtCurrentGym
            ? t('manage.boards.strays.lastBoardTitle')
            : tGyms('create.moveTitle')
        }
        body={
          mergeConfirmTarget?.isLastBoardAtCurrentGym
            ? t('manage.boards.strays.lastBoardBody', { name: mergeConfirmTarget.currentGymName ?? '' })
            : tGyms('create.moveBody', {
                board: mergeConfirmTarget?.name ?? '',
                source: mergeConfirmTarget?.currentGymName ?? '',
              })
        }
        confirmLabel={
          mergeConfirmTarget?.isLastBoardAtCurrentGym
            ? t('manage.boards.strays.lastBoardConfirm')
            : tGyms('create.moveConfirm')
        }
        cancelLabel={t('manage.boards.cancel')}
        confirmColor="primary"
        onConfirm={handleMergeConfirm}
        onClose={() => setMergeConfirmTarget(null)}
      />
    </Box>
  );
}
