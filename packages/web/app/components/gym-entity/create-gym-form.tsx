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

type CreateGymFormProps = {
  boardUuid?: string;
  onSuccess?: (gym: Gym) => void;
  onCancel?: () => void;
};

export default function CreateGymForm({ boardUuid, onSuccess, onCancel }: CreateGymFormProps) {
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
          address: values.address || undefined,
          website: values.website || undefined,
          contactEmail: values.contactEmail || undefined,
          contactPhone: values.contactPhone || undefined,
          isPublic: values.isPublic,
          boardUuid,
        },
      });

      if (data) {
        showMessage(t('gymForm.create.createdNamed', { name: data.createGym.name }), 'success');
        onSuccess?.(data.createGym);
      }
    },
    [execute, boardUuid, showMessage, onSuccess, t],
  );

  return (
    <GymForm
      title={t('gymForm.create.title')}
      submitLabel={t('gymForm.create.submit')}
      initialValues={{
        name: '',
        description: '',
        address: '',
        website: '',
        contactEmail: '',
        contactPhone: '',
        isPublic: true,
      }}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}
