// The owner's "Help train hold finding" switch on an existing wall (SW-20, #5471).
//
// Its own query and mutation, never part of the wall payload: the field has its
// own operation (`spray-training.ts` says why), so a backend that predates it
// costs only this switch, not the whole edit screen.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_SPRAY_WALL_TRAINING_CONSENT,
  SET_SPRAY_WALL_TRAINING_CONSENT,
  type GetSprayWallTrainingConsentQueryResponse,
  type SetSprayWallTrainingConsentMutationResponse,
} from '@boardsesh/graphql/operations/spray-training';
import { getHttpClient } from '../graphql/client';

export const sprayWallTrainingConsentQueryKey = (wallUuid: string | null) =>
  ['sprayWallTrainingConsent', wallUuid] as const;

/**
 * The wall's switch: true or false for its owner, null for anybody else (the
 * server withholds it) and while unknown. `enabled` is the caller's owner check,
 * so a moderator editing somebody's wall never asks.
 */
export function useSprayWallTrainingConsent(wallUuid: string | null, enabled: boolean) {
  return useQuery({
    queryKey: sprayWallTrainingConsentQueryKey(wallUuid),
    enabled: enabled && wallUuid != null,
    queryFn: async (): Promise<boolean | null> => {
      const response = await getHttpClient().request<GetSprayWallTrainingConsentQueryResponse>(
        GET_SPRAY_WALL_TRAINING_CONSENT,
        { uuid: wallUuid },
      );
      return response.sprayWall?.trainingConsent ?? null;
    },
    // An older backend refuses the whole operation. Asking again will not change
    // that, and the screen simply leaves the switch out.
    retry: false,
  });
}

/**
 * Flip the switch. Optimistic, so the switch moves under the thumb; a refusal
 * puts the old value back and the caller says so.
 */
export function useSetSprayWallTrainingConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ wallUuid, consent }: { wallUuid: string; consent: boolean }): Promise<boolean | null> => {
      const response = await getHttpClient().request<SetSprayWallTrainingConsentMutationResponse>(
        SET_SPRAY_WALL_TRAINING_CONSENT,
        { input: { uuid: wallUuid, trainingConsent: consent } },
      );
      return response.updateSprayWall.trainingConsent ?? null;
    },
    onMutate: async ({ wallUuid, consent }) => {
      const queryKey = sprayWallTrainingConsentQueryKey(wallUuid);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<boolean | null>(queryKey);
      queryClient.setQueryData<boolean | null>(queryKey, consent);
      return { previous };
    },
    onError: (_error, { wallUuid }, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(sprayWallTrainingConsentQueryKey(wallUuid), context.previous);
      }
    },
    onSuccess: (saved, { wallUuid }) => {
      if (saved != null) queryClient.setQueryData(sprayWallTrainingConsentQueryKey(wallUuid), saved);
    },
  });
}
