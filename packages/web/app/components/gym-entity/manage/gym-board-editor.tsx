'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import type { UserBoard } from '@boardsesh/shared-schema';
import { GET_BOARD, type GetBoardQueryResponse, type GetBoardQueryVariables } from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import EditBoardForm from '@/app/components/board-entity/edit-board-form';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import ConfirmDialog from './confirm-dialog';

type GymBoardEditorProps = {
  boardUuid: string;
  onBack: () => void;
  onSaved: (board: UserBoard) => void;
  onDirtyChange?: (isDirty: boolean) => void;
};

/** List projections are intentionally incomplete; never use one to initialise an edit. */
export default function GymBoardEditor({ boardUuid, onBack, onSaved, onDirtyChange }: GymBoardEditorProps) {
  const { t } = useTranslation('kiosk');
  const { t: tBoards } = useTranslation('boards');
  const { t: tGyms } = useTranslation('gyms');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const viewerUserId = session?.user?.id ?? null;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const viewerUserIdRef = useRef(viewerUserId);
  viewerUserIdRef.current = viewerUserId;
  const isMountedRef = useRef(true);
  const hasToken = !!token;
  const router = useLocaleRouter();
  const [loadedBoard, setLoadedBoard] = useState<{ board: UserBoard | null; viewerUserId: string | null } | null>(null);
  const board =
    loadedBoard?.viewerUserId === viewerUserId && loadedBoard.board?.uuid === boardUuid ? loadedBoard.board : null;
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const requestGenerationRef = useRef(0);

  const fetchBoard = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
    setIsLoading(true);
    setLoadFailed(false);
    const activeToken = tokenRef.current;
    if (!activeToken) {
      setIsLoading(false);
      setLoadFailed(true);
      return;
    }
    try {
      const client = createGraphQLHttpClient(activeToken);
      const response = await client.request<GetBoardQueryResponse, GetBoardQueryVariables>(GET_BOARD, { boardUuid });
      if (requestGeneration !== requestGenerationRef.current) return;
      setLoadedBoard({ board: response.board ?? null, viewerUserId });
    } catch (error) {
      if (requestGeneration !== requestGenerationRef.current) return;
      console.error('Failed to load board for editing:', error);
      setLoadFailed(true);
    } finally {
      if (requestGeneration === requestGenerationRef.current) setIsLoading(false);
    }
  }, [boardUuid, viewerUserId]);

  useEffect(() => {
    setLoadedBoard(null);
    setIsDirty(false);
    void fetchBoard();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [fetchBoard, hasToken]);

  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      setIsDirty(dirty);
      onDirtyChange?.(dirty);
    },
    [onDirtyChange],
  );

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return (
    <Box>
      <Button
        startIcon={<ArrowBackOutlined />}
        disabled={isSaving}
        onClick={() => {
          if (isDirty) setDiscardOpen(true);
          else onBack();
        }}
        sx={{ mb: 2, textTransform: 'none' }}
      >
        {t('manage.boards.back')}
      </Button>
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : loadFailed ? (
        <Box>
          <Typography color="error">{t('manage.boards.editLoadError')}</Typography>
          <Button onClick={() => void fetchBoard()}>{tGyms('create.retry')}</Button>
        </Box>
      ) : !board ? (
        <Typography color="error">{tBoards('mobile.edit.notFound')}</Typography>
      ) : !board.canEdit ? (
        <Typography color="error">{tBoards('mobile.edit.noAccess')}</Typography>
      ) : (
        <EditBoardForm
          key={board.uuid}
          board={board}
          onSuccess={(updatedBoard) => {
            if (!isMountedRef.current || viewerUserIdRef.current !== viewerUserId) return;
            onSaved(updatedBoard);
            router.refresh();
          }}
          onCancel={onBack}
          onDirtyChange={handleDirtyChange}
          onSavingChange={setIsSaving}
        />
      )}
      <ConfirmDialog
        open={discardOpen}
        title={tBoards('boardForm.edit.discardTitle')}
        body={tBoards('boardForm.edit.discardBody')}
        confirmLabel={tBoards('boardForm.edit.discard')}
        cancelLabel={tBoards('boardForm.edit.keepEditing')}
        onConfirm={() => {
          setDiscardOpen(false);
          onBack();
        }}
        onClose={() => setDiscardOpen(false)}
      />
    </Box>
  );
}
