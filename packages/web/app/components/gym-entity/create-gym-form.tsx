'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import {
  CREATE_GYM,
  type CreateGymMutationVariables,
  type CreateGymMutationResponse,
} from '@boardsesh/graphql/operations';
import type { Gym } from '@boardsesh/shared-schema';
import GymForm, { type GymFormFieldValues } from './gym-form';
import SimilarGymSuggestions from './similar-gym-suggestions';

type CreateGymFormProps = {
  boardUuid?: string;
  onSuccess?: (gym: Gym) => void | Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
};

export default function CreateGymForm({ boardUuid, onSuccess, onCancel, submitLabel }: CreateGymFormProps) {
  const { t } = useTranslation('boards');
  const { showMessage } = useSnackbar();

  const { execute } = useEntityMutation<CreateGymMutationResponse, CreateGymMutationVariables>(CREATE_GYM, {
    errorMessage: t('gymForm.create.errorMessage'),
    authRequiredMessage: t('gymForm.create.authRequired'),
  });

  const handleSubmit = useCallback(
    async (values: GymFormFieldValues) => {
      if (!values.name) {
        showMessage(t('gymForm.create.nameRequired'), 'error');
        return;
      }

      const data = await execute({
        input: {
          name: values.name,
          description: values.description || undefined,
          hours: values.hours?.trim() || undefined,
          address: values.address || undefined,
          website: values.website || undefined,
          contactEmail: values.contactEmail || undefined,
          contactPhone: values.contactPhone || undefined,
          latitude: values.latitude ?? undefined,
          longitude: values.longitude ?? undefined,
          isPublic: values.isPublic,
          boardUuid,
        },
      });

      if (data) {
        showMessage(t('gymForm.create.createdNamed', { name: data.createGym.name }), 'success');
        await onSuccess?.(data.createGym);
      }
    },
    [execute, boardUuid, showMessage, onSuccess, t],
  );

  return (
    <GymForm
      title={t('gymForm.create.title')}
      submitLabel={submitLabel ?? t('gymForm.create.submit')}
      initialValues={{
        name: '',
        description: '',
        hours: '',
        address: '',
        website: '',
        contactEmail: '',
        contactPhone: '',
        isPublic: true,
        latitude: null,
        longitude: null,
      }}
      showHoursField
      onSubmit={handleSubmit}
      onCancel={onCancel}
      renderSuggestions={({ name, latitude, longitude }) => (
        <SimilarGymSuggestions name={name} latitude={latitude} longitude={longitude} />
      )}
    />
  );
}
