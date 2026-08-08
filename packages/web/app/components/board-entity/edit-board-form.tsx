'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
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
  UPDATE_BOARD,
  type UpdateBoardMutationVariables,
  type UpdateBoardMutationResponse,
} from '@boardsesh/graphql/operations';
import { isDuplicateBoardError, readDuplicateBoardError } from '@boardsesh/graphql/errors';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';
import { ANGLES } from '@/app/lib/board-data';
import { getBoardSelectorOptions } from '@/app/lib/board-constants';
import BoardForm, { type BoardFormSubmitState } from './board-form';

/** The values BoardForm hands back on submit. */
type EditBoardFormValues = {
  name: string;
  slug?: string;
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
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  serialNumber?: string;
};

type EditBoardFormProps = {
  board: UserBoard;
  onSuccess?: (board: UserBoard) => void;
  onCancel?: () => void;
  /** When hosted in a drawer, the id wired onto the form for a header-hosted submit. */
  formId?: string;
  /**
   * When provided, the form reports its submit affordance here and the host
   * titles the surface + owns the action bar (so the drawer header, not the
   * form, shows the "Edit Board" title and Save button).
   */
  onSubmitStateChange?: (state: BoardFormSubmitState) => void;
};

export default function EditBoardForm({ board, onSuccess, onCancel, formId, onSubmitStateChange }: EditBoardFormProps) {
  const { t } = useTranslation('boards');
  const { showMessage } = useSnackbar();

  const availableAngles = ANGLES[board.boardType as BoardName] ?? [];

  // The pending duplicate, if the last save was refused for that reason. `name`
  // is null when the server withheld the colliding board's identity — it does
  // that whenever the editor is not the board's owner (a gym admin, a community
  // moderator), so the dialog has to work without a board to name.
  const [duplicate, setDuplicate] = useState<{ name: string | null } | null>(null);
  const lastValuesRef = useRef<EditBoardFormValues | null>(null);

  const handleUpdateError = useCallback(
    (error: unknown, serverMessage: string | null) => {
      // A config collision is a question, not a failure: since #4174 the same
      // wall can legitimately exist twice (home and gym), and the save goes
      // through on a second pass with the user's confirmation attached.
      if (isDuplicateBoardError(error)) {
        setDuplicate({ name: readDuplicateBoardError(error)?.boardName || null });
        track(SHARED_EVENTS.BoardDuplicatePrompted, { boardType: board.boardType, source: 'web_edit_drawer' });
        return;
      }
      showMessage(serverMessage ?? t('editBoard.snackbar.updateFailed'), 'error');
    },
    [board.boardType, showMessage, t],
  );

  const { execute } = useEntityMutation<UpdateBoardMutationResponse, UpdateBoardMutationVariables>(UPDATE_BOARD, {
    successMessage: t('editBoard.snackbar.updated'),
    errorMessage: t('editBoard.snackbar.updateFailed'),
    onError: handleUpdateError,
  });

  const configEditable = useMemo(() => {
    if (!board.canEdit) return undefined;
    const options = getBoardSelectorOptions();
    const boardType = board.boardType as BoardName;
    const layouts = options.layouts[boardType] ?? [];
    if (layouts.length === 0) return undefined;
    return { boardType, layouts, sizes: options.sizes, sets: options.sets };
  }, [board.canEdit, board.boardType]);

  const runUpdate = useCallback(
    async (values: EditBoardFormValues, allowDuplicateConfig?: boolean) => {
      const data = await execute({
        input: {
          boardUuid: board.uuid,
          name: values.name,
          slug: values.slug || undefined,
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
          ...(configEditable
            ? {
                layoutId: values.layoutId,
                sizeId: values.sizeId,
                setIds: values.setIds,
              }
            : {}),
          serialNumber: values.serialNumber,
          allowDuplicateConfig: allowDuplicateConfig || undefined,
        },
      });

      if (data) {
        onSuccess?.(data.updateBoard);
      }
    },
    [execute, board.uuid, onSuccess, configEditable],
  );

  const handleSubmit = useCallback(
    async (values: EditBoardFormValues) => {
      if (!values.name) {
        showMessage(t('boardForm.create.nameRequired'), 'error');
        return;
      }
      // Kept so "save anyway" can replay the exact same edit.
      lastValuesRef.current = values;
      await runUpdate(values);
    },
    [runUpdate, showMessage, t],
  );

  const handleSaveAnyway = useCallback(async () => {
    const values = lastValuesRef.current;
    setDuplicate(null);
    if (!values) return;
    await runUpdate(values, true);
  }, [runUpdate]);

  return (
    <>
      <BoardForm
        // The host drawer titles the surface + hosts the action bar when it asks
        // for submit-state reporting; drop the in-form title so it isn't doubled.
        title={onSubmitStateChange ? '' : t('editBoard.title')}
        submitLabel={t('editBoard.submitLabel')}
        initialValues={{
          name: board.name,
          slug: board.slug,
          description: board.description ?? '',
          locationName: board.locationName ?? '',
          latitude: board.latitude ?? null,
          longitude: board.longitude ?? null,
          isPublic: board.isPublic,
          isUnlisted: board.isUnlisted,
          hideLocation: board.hideLocation,
          isOwned: board.isOwned,
          angle: board.angle,
          isAngleAdjustable: board.isAngleAdjustable,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          serialNumber: board.serialNumber ?? '',
        }}
        showSlugField
        availableAngles={availableAngles}
        configEditable={configEditable}
        onSubmit={handleSubmit}
        onCancel={onCancel}
        formId={formId}
        onSubmitStateChange={onSubmitStateChange}
      />
      {/* A dialog, not a snackbar: this is a choice, and the snackbar's single
          action slot can't carry one. Before this the guard was a flat
          "Failed to update board" with no way past it. */}
      <Dialog open={duplicate !== null} onClose={() => setDuplicate(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('boardForm.edit.duplicateTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {duplicate?.name
              ? t('boardForm.edit.duplicateBody', { name: duplicate.name })
              : t('boardForm.edit.duplicateBodyGeneric')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDuplicate(null)}>{t('boardForm.edit.keepEditing')}</Button>
          <Button onClick={() => void handleSaveAnyway()} variant="contained">
            {t('boardForm.edit.saveAnyway')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
