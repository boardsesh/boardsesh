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
import AddOutlined from '@mui/icons-material/AddOutlined';
import LinkOffOutlined from '@mui/icons-material/LinkOffOutlined';
import AddLinkOutlined from '@mui/icons-material/AddLinkOutlined';
import { useSession } from 'next-auth/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import {
  GET_GYM_BOARDS,
  GET_MY_BOARDS,
  LINK_BOARD_TO_GYM,
  STRAY_BOARDS_FOR_GYM,
  ATTACH_BOARD_TO_GYM,
  type GetGymBoardsQueryResponse,
  type GetGymBoardsQueryVariables,
  type GetMyBoardsQueryResponse,
  type LinkBoardToGymMutationResponse,
  type LinkBoardToGymMutationVariables,
  type StrayBoardsForGymQueryResponse,
  type StrayBoardsForGymQueryVariables,
  type AttachBoardToGymMutationResponse,
  type AttachBoardToGymMutationVariables,
} from '@boardsesh/graphql/operations';
import type { StrayBoard, UserBoard } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { themeTokens } from '@/app/theme/theme-config';
import { canManageGymBoards, canUnlinkBoard, linkableBoards } from './gym-board-permissions';
import type { GymManageTabProps } from './tab-props';

export function VisibilityChip({ board }: { board: Pick<UserBoard, 'isPublic' | 'isUnlisted'> }) {
  const { t } = useTranslation('kiosk');
  if (board.isPublic) {
    return <Chip size="small" color="success" variant="outlined" label={t('manage.boards.visibility.public')} />;
  }
  if (board.isUnlisted) {
    return <Chip size="small" color="warning" variant="outlined" label={t('manage.boards.visibility.unlisted')} />;
  }
  return <Chip size="small" variant="outlined" label={t('manage.boards.visibility.private')} />;
}

export default function GymBoardsTab({ gym }: GymManageTabProps) {
  const { t } = useTranslation('kiosk');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const viewerUserId = session?.user?.id ?? null;
  const [boards, setBoards] = useState<UserBoard[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<UserBoard | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const linkedBoardUuids = useMemo(() => new Set((boards ?? []).map((board) => board.uuid)), [boards]);
  // Backend contract: linking requires gym owner/admin; unlinking requires
  // owning the board. Editors (canEdit) still see the list, read-only.
  const canLinkBoards = canManageGymBoards(gym, viewerUserId);

  // Link and unlink are the SAME backend mutation — LINK_BOARD_TO_GYM with
  // gymUuid: null performs the unlink. Two instances only so each direction
  // gets its own success/error toast copy.
  const linkMutation = useEntityMutation<LinkBoardToGymMutationResponse, LinkBoardToGymMutationVariables>(
    LINK_BOARD_TO_GYM,
    { successMessage: t('manage.boards.linked'), errorMessage: t('manage.boards.linkFailed') },
  );
  const unlinkMutation = useEntityMutation<LinkBoardToGymMutationResponse, LinkBoardToGymMutationVariables>(
    LINK_BOARD_TO_GYM,
    { successMessage: t('manage.boards.unlinked'), errorMessage: t('manage.boards.unlinkFailed') },
  );

  const fetchBoards = useCallback(async () => {
    if (!token) return;
    setLoadError(false);
    try {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<GetGymBoardsQueryResponse, GetGymBoardsQueryVariables>(GET_GYM_BOARDS, {
        gymUuid: gym.uuid,
      });
      setBoards(data.gymBoards ?? []);
    } catch (error) {
      console.error('Failed to load gym boards:', error);
      setLoadError(true);
      setBoards([]);
    }
  }, [token, gym.uuid]);

  useEffect(() => {
    void fetchBoards();
  }, [fetchBoards]);

  const handleUnlinkConfirm = async () => {
    if (!unlinkTarget) return;
    const target = unlinkTarget;
    setUnlinkTarget(null);
    const result = await unlinkMutation.execute({ input: { boardUuid: target.uuid, gymUuid: null } });
    if (result) {
      await fetchBoards();
    }
  };

  // Returns whether the link succeeded so the dialog only drops the candidate
  // on an actual success (useEntityMutation resolves null on failure).
  const handleLink = async (boardUuid: string): Promise<boolean> => {
    const result = await linkMutation.execute({ input: { boardUuid, gymUuid: gym.uuid } });
    if (result) {
      await fetchBoards();
      return true;
    }
    return false;
  };

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
      {!canLinkBoards && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {t('manage.boards.readOnlyHint')}
        </Typography>
      )}

      {boards === null ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : loadError ? (
        <Typography variant="body2" color="error" sx={{ py: 2 }}>
          {t('manage.boards.loadError')}
        </Typography>
      ) : boards.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {t('manage.boards.empty')}
        </Typography>
      ) : (
        <List disablePadding>
          {boards.map((board) => (
            <ListItem
              key={board.uuid}
              divider
              disableGutters
              secondaryAction={
                canUnlinkBoard(board, viewerUserId) ? (
                  <Button
                    size="small"
                    color="error"
                    startIcon={<LinkOffOutlined />}
                    onClick={() => setUnlinkTarget(board)}
                    sx={{ textTransform: 'none' }}
                  >
                    {t('manage.boards.unlink')}
                  </Button>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    {t('manage.boards.onlyOwnerCanUnlink')}
                  </Typography>
                )
              }
            >
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography component="span" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                      {board.name}
                    </Typography>
                    <VisibilityChip board={board} />
                  </Box>
                }
                secondary={`${boardTypeLabel(board.boardType)} · ${board.angle}°`}
              />
            </ListItem>
          ))}
        </List>
      )}

      {gym.canEdit && <StrayBoardsSection gymUuid={gym.uuid} onAttached={fetchBoards} />}

      <Dialog open={unlinkTarget !== null} onClose={() => setUnlinkTarget(null)}>
        <DialogTitle>{t('manage.boards.unlinkTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('manage.boards.unlinkBody', { name: unlinkTarget?.name ?? '' })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUnlinkTarget(null)} sx={{ textTransform: 'none' }}>
            {t('manage.boards.cancel')}
          </Button>
          <Button onClick={handleUnlinkConfirm} color="error" autoFocus sx={{ textTransform: 'none' }}>
            {t('manage.boards.unlinkConfirm')}
          </Button>
        </DialogActions>
      </Dialog>

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
  const { token } = useWsAuthToken();
  const [candidates, setCandidates] = useState<UserBoard[] | null>(null);
  const [linkingUuid, setLinkingUuid] = useState<string | null>(null);

  // The candidates fetch runs once per dialog open. `linkedBoardUuids` changes
  // after every successful link (the parent refetches gymBoards), so reading it
  // through a ref keeps it out of the effect deps — otherwise each link would
  // re-fetch myBoards and blank the open dialog behind a spinner. While the
  // dialog is open the list is maintained optimistically in handleLinkClick.
  const linkedBoardUuidsRef = useRef(linkedBoardUuids);
  useEffect(() => {
    linkedBoardUuidsRef.current = linkedBoardUuids;
  }, [linkedBoardUuids]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    setCandidates(null);
    void (async () => {
      try {
        const client = createGraphQLHttpClient(token);
        const data = await client.request<GetMyBoardsQueryResponse>(GET_MY_BOARDS, {
          input: { limit: 50, offset: 0 },
        });
        if (cancelled) return;
        // ownerId, not isOwned — myBoards includes followed boards, and isOwned
        // is the physical-ownership column, not the account that may link it.
        setCandidates(linkableBoards(data.myBoards.boards, gymUuid, linkedBoardUuidsRef.current, viewerUserId));
      } catch (error) {
        console.error('Failed to load your boards:', error);
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, token, gymUuid, viewerUserId]);

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
        {candidates === null ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              {t('manage.boards.addDialog.loading')}
            </Typography>
          </Box>
        ) : candidates.length === 0 ? (
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
 * "Boards that might be yours": candidates the backend surfaces as physically at
 * this gym (within ~150 m, unlinked or on a synced listing) or left behind by a
 * merged listing. One tap re-points the board to this gym. Only mounted for
 * viewers with gym edit access — the resolver enforces the same gate.
 */
function StrayBoardsSection({ gymUuid, onAttached }: StrayBoardsSectionProps) {
  const { t } = useTranslation('kiosk');
  const { token } = useWsAuthToken();
  const [strays, setStrays] = useState<StrayBoard[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attachingUuid, setAttachingUuid] = useState<string | null>(null);

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
    async (board: StrayBoard) => {
      setAttachingUuid(board.uuid);
      try {
        const result = await attachMutation.execute({ input: { gymUuid, boardUuid: board.uuid } });
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
                  onClick={() => handleAttach(board)}
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
                primary={board.name}
                secondary={
                  board.currentGymName
                    ? `${reasonText(board)} · ${t('manage.boards.strays.onListing', { name: board.currentGymName })}`
                    : reasonText(board)
                }
              />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}
