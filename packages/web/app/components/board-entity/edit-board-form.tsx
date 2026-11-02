'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
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
  ADMIN_UPDATE_BOARD,
  type AdminUpdateBoardMutationResponse,
  type UpdateBoardMutationVariables,
  type UpdateBoardMutationResponse,
} from '@boardsesh/graphql/operations';
import { isBoardLimitError, isDuplicateBoardError, readDuplicateBoardError } from '@boardsesh/graphql/errors';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';
import type { AdminBoard, UserBoard } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';
import { ANGLES } from '@/app/lib/board-data';
import { getBoardSelectorOptions } from '@/app/lib/board-constants';
import BoardForm, { type BoardFormFieldValues, type BoardFormSubmitState } from './board-form';
import { boardEditPermissions, buildBoardUpdateInput } from './board-edit-input';

type EditBoardFormProps = {
  onDirtyChange?: (isDirty: boolean) => void;
  onSavingChange?: (isSaving: boolean) => void;
  onCancel?: () => void;
  /** When hosted in a drawer, the id wired onto the form for a header-hosted submit. */
  formId?: string;
  /**
   * When provided, the form reports its submit affordance here and the host
   * titles the surface + owns the action bar (so the drawer header, not the
   * form, shows the "Edit Board" title and Save button).
   */
  onSubmitStateChange?: (state: BoardFormSubmitState) => void;
} & (
  | { mode?: 'standard'; board: UserBoard; onSuccess?: (board: UserBoard) => void }
  | { mode: 'admin'; board: AdminBoard; onSuccess?: (board: AdminBoard) => void }
);

export default function EditBoardForm(props: EditBoardFormProps) {
  const { board, onCancel, formId, onSubmitStateChange, onDirtyChange, onSavingChange } = props;
  const { t } = useTranslation('boards');
  const { showMessage } = useSnackbar();
  const { data: session } = useSession();
  const permissions = boardEditPermissions(board, session?.user?.id ?? null);
  const [isSaving, setIsSaving] = useState(false);

  const availableAngles = ANGLES[board.boardType as BoardName] ?? [];

  // The pending duplicate, if the last save was refused for that reason. Both
  // fields are null when the server withheld the colliding board's identity —
  // it does that whenever the editor is not the board's owner (a gym admin, a
  // community moderator), so the dialog has to work without a board to name.
  //
  // `duplicate` and `duplicateDialogOpen` are split so the dialog's ~300ms fade
  // -out transition still has content to render: closing sets only `open` to
  // false, and `duplicate` itself is cleared from `TransitionProps.onExited`,
  // once the exit animation actually finishes. Clearing both at once (the
  // original approach) let MUI re-render the closing dialog's body against
  // `duplicate === null` mid-fade, flashing the generic fallback copy.
  const [duplicate, setDuplicate] = useState<{ name: string | null; locationName: string | null } | null>(null);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const lastValuesRef = useRef<BoardFormFieldValues | null>(null);
  // `runUpdate` fires from two places — the drawer's Save button and the
  // duplicate dialog's "Save anyway" retry — and neither is disabled while the
  // other is in flight. A double-click on "Save anyway" during the dialog's
  // close transition, or a Save click while a retry is still pending, could
  // fire two updateBoard mutations. Mirrors the inFlightRef idiom in
  // packages/mobile/app/boards/create.tsx.
  const inFlightRef = useRef(false);

  const handleUpdateError = useCallback(
    (error: unknown, serverMessage: string | null) => {
      // A config collision is a question, not a failure: since #4174 the same
      // wall can legitimately exist twice (home and gym), and the save goes
      // through on a second pass with the user's confirmation attached.
      if (isDuplicateBoardError(error)) {
        const duplicateError = readDuplicateBoardError(error);
        setDuplicate({ name: duplicateError?.boardName || null, locationName: duplicateError?.locationName || null });
        setDuplicateDialogOpen(true);
        track(SHARED_EVENTS.BoardDuplicatePrompted, {
          boardType: board.boardType,
          source: 'web_edit_drawer',
          hasLocation: !!lastValuesRef.current?.locationName,
        });
        return;
      }
      // Saving a soft-deleted board restores it, which can land the owner back
      // at the 50-board cap. Same account-cap copy as board creation, since the
      // way out (delete a board you don't use) is identical.
      if (isBoardLimitError(error)) {
        showMessage(t('boardForm.create.limitReached'), 'error');
        return;
      }
      showMessage(serverMessage ?? t('editBoard.snackbar.updateFailed'), 'error');
    },
    [board.boardType, showMessage, t],
  );

  const { execute } = useEntityMutation<
    UpdateBoardMutationResponse | AdminUpdateBoardMutationResponse,
    UpdateBoardMutationVariables
  >(props.mode === 'admin' ? ADMIN_UPDATE_BOARD : UPDATE_BOARD, {
    successMessage: t('editBoard.snackbar.updated'),
    onError: handleUpdateError,
  });

  const configEditable = useMemo(() => {
    if (!board.canEdit || board.boardType === 'spray') return undefined;
    const options = getBoardSelectorOptions();
    const boardType = board.boardType as BoardName;
    const layouts = options.layouts[boardType] ?? [];
    if (layouts.length === 0) return undefined;
    return { boardType, layouts, sizes: options.sizes, sets: options.sets };
  }, [board.canEdit, board.boardType]);

  const runUpdate = useCallback(
    async (fields: BoardFormFieldValues, allowDuplicateConfig?: boolean) => {
      if (inFlightRef.current) return;
      const input = buildBoardUpdateInput(board, fields, permissions);
      if (Object.keys(input).length === 1) return;
      if (allowDuplicateConfig) input.allowDuplicateConfig = true;
      inFlightRef.current = true;
      setIsSaving(true);
      onSavingChange?.(true);
      try {
        const result = await execute({ input });
        if (result) {
          if (props.mode === 'admin' && 'adminUpdateBoard' in result) {
            props.onSuccess?.(result.adminUpdateBoard);
          } else if (props.mode !== 'admin' && 'updateBoard' in result) {
            props.onSuccess?.(result.updateBoard);
          }
        }
      } finally {
        inFlightRef.current = false;
        setIsSaving(false);
        onSavingChange?.(false);
      }
    },
    [execute, board, permissions, props, onSavingChange],
  );

  const handleSubmit = useCallback(
    async (values: BoardFormFieldValues) => {
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
    setDuplicateDialogOpen(false);
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
          hasLeds: board.hasLeds,
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
        onDirtyChange={onDirtyChange}
        requireChanges
        permissions={permissions}
        saving={isSaving}
      />
      {/* A dialog, not a snackbar: this is a choice, and the snackbar's single
          action slot can't carry one. Before this the guard was a flat
          "Failed to update board" with no way past it. */}
      <Dialog
        open={duplicateDialogOpen}
        onClose={() => {
          if (!isSaving) setDuplicateDialogOpen(false);
        }}
        TransitionProps={{ onExited: () => setDuplicate(null) }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('boardForm.edit.duplicateTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {duplicate?.name && duplicate.locationName
              ? t('boardForm.edit.duplicateBodyWithLocation', {
                  name: duplicate.name,
                  location: duplicate.locationName,
                })
              : duplicate?.name
                ? t('boardForm.edit.duplicateBody', { name: duplicate.name })
                : t('boardForm.edit.duplicateBodyGeneric')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={isSaving} onClick={() => setDuplicateDialogOpen(false)}>
            {t('boardForm.edit.cancel')}
          </Button>
          <Button disabled={isSaving} onClick={() => void handleSaveAnyway()} variant="contained">
            {t('boardForm.edit.saveAnyway')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
