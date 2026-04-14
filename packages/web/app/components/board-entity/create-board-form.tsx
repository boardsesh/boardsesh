'use client';

import React, { useCallback } from 'react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import {
  CREATE_BOARD,
  type CreateBoardMutationVariables,
  type CreateBoardMutationResponse,
} from '@/app/lib/graphql/operations';
import { useRouter } from 'next/navigation';
import { constructBoardSlugListUrl } from '@/app/lib/url-utils';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';
import { ANGLES } from '@/app/lib/board-data';
import { useViewModePreference } from '@/app/hooks/use-view-mode-preference';
import BoardForm from './board-form';

interface CreateBoardFormProps {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  defaultAngle: number;
  onSuccess?: (board: UserBoard) => void;
  onCancel?: () => void;
}

export default function CreateBoardForm({
  boardType,
  layoutId,
  sizeId,
  setIds,
  defaultAngle,
  onSuccess,
  onCancel,
}: CreateBoardFormProps) {
  const { showMessage } = useSnackbar();
  const router = useRouter();
  const viewMode = useViewModePreference();

  const availableAngles = ANGLES[boardType as BoardName] ?? [];

  const { execute } = useEntityMutation<CreateBoardMutationResponse, CreateBoardMutationVariables>(CREATE_BOARD, {
    errorMessage: 'Failed to create board. It may already exist for this configuration.',
    authRequiredMessage: 'You must be signed in to create a board',
  });

  const handleSubmit = useCallback(
    async (values: {
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
    }) => {
      if (!values.name) {
        showMessage('Board name is required', 'error');
        return;
      }

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
        },
      });

      if (data) {
        const board = data.createBoard;
        showMessage(`Board "${board.name}" created!`, 'success');

        if (onSuccess) {
          onSuccess(board);
        } else {
          router.push(constructBoardSlugListUrl(board.slug, defaultAngle, viewMode));
        }
      }
    },
    [execute, boardType, layoutId, sizeId, setIds, defaultAngle, showMessage, router, onSuccess],
  );

  return (
    <BoardForm
      title=""
      submitLabel="Create Board"
      initialValues={{
        name: '',
        description: '',
        locationName: '',
        isPublic: true,
        isUnlisted: false,
        hideLocation: false,
        isOwned: true,
      }}
      namePlaceholder="e.g., Home Board, Gym Name"
      locationPlaceholder="e.g., City, Gym Name"
      availableAngles={availableAngles}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}
