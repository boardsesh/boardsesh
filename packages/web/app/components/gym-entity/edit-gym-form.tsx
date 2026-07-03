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
};

export default function EditGymForm({ gym, onSuccess, onCancel }: EditGymFormProps) {
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
          address: values.address || undefined,
          website: values.website || null,
          contactEmail: values.contactEmail || undefined,
          contactPhone: values.contactPhone || undefined,
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
        address: gym.address ?? '',
        website: gym.website ?? '',
        contactEmail: gym.contactEmail ?? '',
        contactPhone: gym.contactPhone ?? '',
        isPublic: gym.isPublic,
      }}
      showSlugField
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}
