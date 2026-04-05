'use client';

import { useCallback } from 'react';
import { useUpdateTick } from '@/app/hooks/use-update-tick';
import { useDeleteTick } from '@/app/hooks/use-delete-tick';
import type { EditAscentValues } from './edit-ascent-dialog';
import type { BoardName } from '@/app/lib/types';

/**
 * Hook providing update and delete actions for ascents.
 * Wraps useUpdateTick and useDeleteTick with a simple interface
 * compatible with AscentActionsMenu callbacks.
 */
export function useAscentActions(boardName: BoardName) {
  const updateMutation = useUpdateTick(boardName);
  const deleteMutation = useDeleteTick(boardName);

  // Depend on .mutate (stable function ref) not the whole mutation object
  const { mutate: updateMutate } = updateMutation;
  const { mutate: deleteMutate } = deleteMutation;

  const handleUpdate = useCallback(
    (uuid: string, values: EditAscentValues) => {
      updateMutate({
        uuid,
        status: values.status,
        attemptCount: values.attemptCount,
        quality: values.quality,
        comment: values.comment,
      });
    },
    [updateMutate],
  );

  const handleDelete = useCallback(
    (uuid: string) => {
      deleteMutate({ uuid });
    },
    [deleteMutate],
  );

  return {
    handleUpdate,
    handleDelete,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
