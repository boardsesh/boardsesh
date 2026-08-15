'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import {
  UPDATE_GYM,
  type UpdateGymMutationVariables,
  type UpdateGymMutationResponse,
} from '@boardsesh/graphql/operations';
import type { Gym } from '@boardsesh/shared-schema';
import GymForm, { type GymFormFieldValues } from './gym-form';

type EditGymFormProps = {
  gym: Gym;
  onSuccess?: (gym: Gym) => void;
  onCancel?: () => void;
  /** Bubbles the form's unsaved-edit state (used by the console's dirty guard). */
  onDirtyChange?: (isDirty: boolean) => void;
};

export default function EditGymForm({ gym, onSuccess, onCancel, onDirtyChange }: EditGymFormProps) {
  const { t } = useTranslation('boards');
  const { showMessage } = useSnackbar();

  const { execute } = useEntityMutation<UpdateGymMutationResponse, UpdateGymMutationVariables>(UPDATE_GYM, {
    successMessage: t('editGym.snackbar.updated'),
    errorMessage: t('editGym.snackbar.updateFailed'),
  });

  const handleSubmit = useCallback(
    async (values: GymFormFieldValues) => {
      if (!values.name) {
        showMessage(t('gymForm.create.nameRequired'), 'error');
        return;
      }

      const data = await execute({
        input: {
          gymUuid: gym.uuid,
          name: values.name,
          slug: values.slug || undefined,
          description: values.description || undefined,
          // `null`, not `undefined`: updateGym treats an omitted key as "leave the
          // hours (and their confirmed date) alone", so an owner who empties the
          // field could never clear it if this sent undefined.
          hours: values.hours?.trim() || null,
          address: values.address || undefined,
          website: values.website || null,
          contactEmail: values.contactEmail || undefined,
          contactPhone: values.contactPhone || undefined,
          latitude: values.latitude,
          longitude: values.longitude,
          isPublic: values.isPublic,
        },
      });

      if (data) {
        onSuccess?.(data.updateGym);
      }
    },
    [execute, gym.uuid, showMessage, onSuccess, t],
  );

  return (
    <GymForm
      title={t('editGym.title')}
      submitLabel={t('editGym.submitLabel')}
      initialValues={{
        name: gym.name,
        slug: gym.slug ?? '',
        description: gym.description ?? '',
        hours: gym.hours ?? '',
        address: gym.address ?? '',
        website: gym.website ?? '',
        contactEmail: gym.contactEmail ?? '',
        contactPhone: gym.contactPhone ?? '',
        isPublic: gym.isPublic,
        latitude: gym.latitude ?? null,
        longitude: gym.longitude ?? null,
      }}
      showSlugField
      showHoursField
      onSubmit={handleSubmit}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
    />
  );
}
