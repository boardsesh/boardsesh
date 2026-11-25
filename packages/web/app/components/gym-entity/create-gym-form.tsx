'use client';

import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import {
  CREATE_GYM,
  type CreateGymMutationVariables,
  type CreateGymMutationResponse,
} from '@boardsesh/graphql/operations';
import { isGymLimitError, readSimilarGymsError } from '@boardsesh/graphql/errors';
import type { CreateGymInput, Gym, SimilarGym } from '@boardsesh/shared-schema';
import GymForm, { type GymFormFieldValues } from './gym-form';
import SimilarGymSuggestions from './similar-gym-suggestions';
import SimilarGymRefusalDialog from './similar-gym-refusal-dialog';

/** Mirrors the server's cap on `duplicateCheck.acknowledgedGymUuids`. */
const MAX_ACKNOWLEDGED_GYM_UUIDS = 50;

type CreateGymFormProps = {
  boardUuid?: string;
  onSuccess?: (gym: Gym) => void | Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
};

export default function CreateGymForm({ boardUuid, onSuccess, onCancel, submitLabel }: CreateGymFormProps) {
  const { t } = useTranslation('boards');
  const { showMessage } = useSnackbar();
  // The gyms the server's GYM_SIMILAR_EXISTS refusal named, shown in the dialog.
  const [refusedGyms, setRefusedGyms] = useState<SimilarGym[] | null>(null);
  const [isConfirmingSeparate, setIsConfirmingSeparate] = useState(false);
  // The input the refusal answered, and every gym shown since that Save. A
  // confirmation names them all, so gyms past the first five come up in turn
  // instead of the same refusal coming back.
  const pendingInputRef = useRef<CreateGymInput | null>(null);
  const acknowledgedGymUuidsRef = useRef<string[]>([]);

  const handleCreateError = useCallback(
    (error: unknown, serverMessage: string | null) => {
      const similarGyms = readSimilarGymsError(error);
      if (similarGyms && similarGyms.length > 0) {
        setRefusedGyms(similarGyms);
        return;
      }
      setRefusedGyms(null);
      if (isGymLimitError(error)) {
        showMessage(t('gymForm.create.limitReached'), 'error');
        return;
      }
      showMessage(serverMessage ?? t('gymForm.create.errorMessage'), 'error');
    },
    [showMessage, t],
  );

  const { execute } = useEntityMutation<CreateGymMutationResponse, CreateGymMutationVariables>(CREATE_GYM, {
    errorMessage: t('gymForm.create.errorMessage'),
    authRequiredMessage: t('gymForm.create.authRequired'),
    onError: handleCreateError,
  });

  const submitCreate = useCallback(
    async (input: CreateGymInput, acknowledgedGymUuids: string[]) => {
      const data = await execute({
        input:
          acknowledgedGymUuids.length > 0
            ? { ...input, duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids } }
            : input,
      });

      if (data) {
        setRefusedGyms(null);
        showMessage(t('gymForm.create.createdNamed', { name: data.createGym.name }), 'success');
        await onSuccess?.(data.createGym);
      }
    },
    [execute, showMessage, onSuccess, t],
  );

  const handleSubmit = useCallback(
    async (values: GymFormFieldValues) => {
      const name = values.name.trim();
      if (!name) {
        showMessage(t('gymForm.create.nameRequired'), 'error');
        return;
      }

      const input: CreateGymInput = {
        name,
        description: values.description || undefined,
        hours: values.hours?.trim() || undefined,
        address: values.address || undefined,
        website: values.website || undefined,
        contactEmail: values.contactEmail || undefined,
        contactPhone: values.contactPhone || undefined,
        latitude: values.latitude ?? undefined,
        longitude: values.longitude ?? undefined,
        isPublic: values.isPublic,
        isListed: values.isListed,
        boardUuid,
      };
      // A fresh Save starts a fresh check: the form may have changed since.
      pendingInputRef.current = input;
      acknowledgedGymUuidsRef.current = [];
      await submitCreate(input, []);
    },
    [boardUuid, showMessage, submitCreate, t],
  );

  const handleConfirmSeparate = useCallback(async () => {
    const pendingInput = pendingInputRef.current;
    if (!pendingInput || !refusedGyms) return;
    // The server takes at most 50; keep the most recent ones, which are the
    // nearest the next refusal could name again.
    acknowledgedGymUuidsRef.current = [
      ...new Set([...acknowledgedGymUuidsRef.current, ...refusedGyms.map((gym) => gym.uuid)]),
    ].slice(-MAX_ACKNOWLEDGED_GYM_UUIDS);
    setIsConfirmingSeparate(true);
    try {
      await submitCreate(pendingInput, acknowledgedGymUuidsRef.current);
    } finally {
      setIsConfirmingSeparate(false);
    }
  }, [refusedGyms, submitCreate]);

  return (
    <>
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
          isListed: true,
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
      <SimilarGymRefusalDialog
        gyms={refusedGyms}
        isSubmitting={isConfirmingSeparate}
        onConfirmSeparate={() => void handleConfirmSeparate()}
        onClose={() => setRefusedGyms(null)}
      />
    </>
  );
}
