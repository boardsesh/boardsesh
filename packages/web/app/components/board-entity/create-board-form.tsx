'use client';

import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import {
  CREATE_BOARD,
  type CreateBoardMutationVariables,
  type CreateBoardMutationResponse,
} from '@boardsesh/graphql/operations';
import { readDuplicateBoardError, type DuplicateBoardError } from '@boardsesh/graphql/errors';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { constructBoardSlugListUrl } from '@/app/lib/url-utils';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';
import { ANGLES } from '@/app/lib/board-data';
import BoardForm, { type BoardFormSubmitState } from './board-form';

/** The values BoardForm hands back on submit. */
type CreateBoardFormValues = {
  name: string;
  description: string;
  locationName: string;
  latitude?: number | null;
  longitude?: number | null;
  isPublic: boolean;
  isUnlisted: boolean;
  hideLocation: boolean;
  isOwned: boolean;
  angle?: number;
  isAngleAdjustable?: boolean;
};

type CreateBoardFormProps = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  defaultAngle: number;
  onSuccess?: (board: UserBoard) => void;
  onCancel?: () => void;
  /** When hosted in a drawer, the id wired onto the form for a header-hosted submit. */
  formId?: string;
  /** When provided, the form reports its submit affordance here so the drawer header hosts the action. */
  onSubmitStateChange?: (state: BoardFormSubmitState) => void;
};

export default function CreateBoardForm({
  boardType,
  layoutId,
  sizeId,
  setIds,
  defaultAngle,
  onSuccess,
  onCancel,
  formId,
  onSubmitStateChange,
}: CreateBoardFormProps) {
  const { t } = useTranslation('boards');
  const { showMessage } = useSnackbar();
  const router = useLocaleRouter();

  const availableAngles = ANGLES[boardType as BoardName] ?? [];

  // The pending duplicate, if the last create was refused for that reason. Held
  // so the dialog can offer "add it anyway", which re-runs the create with the
  // confirmation flag.
  const [duplicate, setDuplicate] = useState<DuplicateBoardError | null>(null);
  const lastValuesRef = useRef<CreateBoardFormValues | null>(null);

  const handleCreateError = useCallback(
    async (error: unknown, serverMessage: string | null) => {
      // Gate strictly on the server's code. This used to look up an owned board
      // matching the config on EVERY error, so a rate-limit or auth failure
      // reported itself as a duplicate whenever such a board happened to exist.
      const duplicateError = readDuplicateBoardError(error);
      if (duplicateError) {
        track(SHARED_EVENTS.BoardDuplicatePrompted, { boardType, source: 'web_drawer' });
        setDuplicate(duplicateError);
        return;
      }
      track(SHARED_EVENTS.BoardCreateFailed, {
        boardType,
        source: 'web_drawer',
        error_reason: 'exception',
      });
      showMessage(serverMessage ?? t('boardForm.create.errorMessage'), 'error');
    },
    [boardType, showMessage, t],
  );

  const { execute } = useEntityMutation<CreateBoardMutationResponse, CreateBoardMutationVariables>(CREATE_BOARD, {
    errorMessage: t('boardForm.create.errorMessage'),
    authRequiredMessage: t('boardForm.create.authRequired'),
    onError: handleCreateError,
  });

  const runCreate = useCallback(
    async (values: CreateBoardFormValues, allowDuplicateConfig?: boolean) => {
      const data = await execute({
        input: {
          boardType,
          layoutId,
          sizeId,
          setIds,
          name: values.name,
          description: values.description || undefined,
          locationName: values.locationName || undefined,
          latitude: values.latitude ?? undefined,
          longitude: values.longitude ?? undefined,
          isPublic: values.isPublic,
          isUnlisted: values.isUnlisted,
          hideLocation: values.hideLocation,
          isOwned: values.isOwned,
          angle: values.angle,
          isAngleAdjustable: values.isAngleAdjustable,
          allowDuplicateConfig: allowDuplicateConfig || undefined,
        },
      });

      if (data) {
        const board = data.createBoard;
        track(SHARED_EVENTS.BoardCreated, {
          boardType,
          layoutId,
          sizeId,
          setCount: setIds.split(',').filter(Boolean).length,
          angle: values.angle,
          isOwned: values.isOwned,
          isPublic: values.isPublic,
          hasLocationName: !!values.locationName,
          hasCoords: values.latitude != null && values.longitude != null,
          source: 'web_drawer',
          allowedDuplicate: !!allowDuplicateConfig,
        });
        showMessage(t('boardForm.create.createdNamed', { name: board.name }), 'success');

        if (onSuccess) {
          onSuccess(board);
        } else {
          router.push(constructBoardSlugListUrl(board.slug, defaultAngle));
        }
      }
    },
    [execute, boardType, layoutId, sizeId, setIds, defaultAngle, showMessage, router, onSuccess, t],
  );

  const handleSubmit = useCallback(
    async (values: CreateBoardFormValues) => {
      if (!values.name) {
        showMessage(t('boardForm.create.nameRequired'), 'error');
        return;
      }
      // Kept so "add it anyway" can replay the exact same values.
      lastValuesRef.current = values;
      await runCreate(values);
    },
    [runCreate, showMessage, t],
  );

  const handleGoToExisting = useCallback(() => {
    if (!duplicate?.boardSlug) return;
    setDuplicate(null);
    // The board's OWN angle, not this board type's default — the two rarely
    // match, and landing on the wrong one shows an empty-looking wall.
    router.push(constructBoardSlugListUrl(duplicate.boardSlug, duplicate.angle ?? defaultAngle));
  }, [duplicate, router, defaultAngle]);

  const handleAddAnyway = useCallback(async () => {
    const values = lastValuesRef.current;
    setDuplicate(null);
    if (!values) return;
    await runCreate(values, true);
  }, [runCreate]);

  return (
    <>
      <BoardForm
        title=""
        submitLabel={t('boardForm.create.submit')}
        initialValues={{
          name: '',
          description: '',
          locationName: '',
          isPublic: true,
          isUnlisted: false,
          hideLocation: false,
          isOwned: true,
        }}
        namePlaceholder={t('boardForm.create.namePlaceholder')}
        locationPlaceholder={t('boardForm.create.locationPlaceholder')}
        availableAngles={availableAngles}
        onSubmit={handleSubmit}
        onCancel={onCancel}
        formId={formId}
        onSubmitStateChange={onSubmitStateChange}
      />
      {/* A dialog, not a snackbar: the snackbar has one action slot and this
          needs three outcomes. Before #4166 there was no "add it anyway" at all,
          so a second board of the same setup at a new gym was unreachable. */}
      <Dialog open={duplicate !== null} onClose={() => setDuplicate(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('boardForm.create.duplicateTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('boardForm.create.duplicateBody', { name: duplicate?.boardName ?? '' })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDuplicate(null)}>{t('boardForm.create.keepEditing')}</Button>
          {duplicate?.boardSlug ? (
            <Button onClick={handleGoToExisting}>{t('boardForm.create.goToExisting')}</Button>
          ) : null}
          <Button onClick={() => void handleAddAnyway()} variant="contained">
            {t('boardForm.create.addAnyway')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
