'use client';

import { useCallback, useState } from 'react';
import { useUpdateTick } from '@/app/hooks/use-update-tick';
import { useDeleteTick } from '@/app/hooks/use-delete-tick';
import type { EditAscentValues } from './edit-ascent-dialog';
import type { BoardName } from '@/app/lib/types';

interface UseAscentActionsOptions {
  /** Called after a successful update or delete (e.g., to invalidate queries). */
  onSettled?: () => void;
}

/**
 * Hook providing update and delete actions for ascents.
 * Wraps useUpdateTick and useDeleteTick with a simple interface
 * compatible with AscentActionsMenu callbacks.
 *
 * Tracks the UUID of the currently mutating item so consumers
 * can show per-item loading state.
 */
export function useAscentActions(boardName: BoardName, options?: UseAscentActionsOptions) {
  const updateMutation = useUpdateTick(boardName);
  const deleteMutation = useDeleteTick(boardName);
  const [mutatingUuid, setMutatingUuid] = useState<string | null>(null);

  const { mutateAsync: updateAsync } = updateMutation;
  const { mutateAsync: deleteAsync } = deleteMutation;

  const handleUpdate = useCallback(
    async (uuid: string, values: EditAscentValues) => {
      setMutatingUuid(uuid);
      try {
        await updateAsync({
          uuid,
          status: values.status,
          attemptCount: values.attemptCount,
          quality: values.quality,
          comment: values.comment,
        });
        options?.onSettled?.();
      } finally {
        setMutatingUuid(null);
      }
    },
    [updateAsync, options?.onSettled],
  );

  const handleDelete = useCallback(
    async (uuid: string) => {
      setMutatingUuid(uuid);
      try {
        await deleteAsync({ uuid });
        options?.onSettled?.();
      } finally {
        setMutatingUuid(null);
      }
    },
    [deleteAsync, options?.onSettled],
  );

  return {
    handleUpdate,
    handleDelete,
    mutatingUuid,
  };
}
