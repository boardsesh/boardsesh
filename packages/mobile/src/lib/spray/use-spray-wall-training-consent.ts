// The owner's "Help train hold finding" switch on an existing wall (SW-20, #5471).
//
// Its own query and mutation, never part of the wall payload: the field has its
// own operation (`spray-training.ts` says why), so a backend that predates it
// costs only this switch, not the whole edit screen.

import { useCallback, useMemo } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  GET_SPRAY_WALL_TRAINING_CONSENT,
  SET_SPRAY_WALL_TRAINING_CONSENT,
  type GetSprayWallTrainingConsentQueryResponse,
  type SetSprayWallTrainingConsentMutationResponse,
} from '@boardsesh/graphql/operations/spray-training';
import { getHttpClient } from '../graphql/client';

export const sprayWallTrainingConsentQueryKey = (wallUuid: string) => ['sprayWallTrainingConsent', wallUuid] as const;

/** Per wall, so a flip on the wire is counted whichever switch for that wall sent it. */
const setSprayWallTrainingConsentMutationKey = (wallUuid: string | null) =>
  ['setSprayWallTrainingConsent', wallUuid] as const;

/**
 * Whether a flip of this wall's switch is still on the wire, whichever switch
 * sent it. Never for `null`, a wall that does not exist yet.
 *
 * For a screen that hosts the switch and must not move on mid-flip: it reads
 * the mutation cache, so the host holds no state of its own, and a flip on some
 * other wall does not hold it.
 */
export function useSprayWallTrainingConsentSaving(wallUuid: string | null): boolean {
  return useIsMutating({ mutationKey: setSprayWallTrainingConsentMutationKey(wallUuid) }) > 0;
}

/**
 * The same answer read at call time, for a handler. The hook above is one render
 * behind the tap that started the flip, and a second press that queued up behind
 * that tap runs before the render.
 */
export function isSprayWallTrainingConsentSaving(queryClient: QueryClient, wallUuid: string | null): boolean {
  return queryClient.isMutating({ mutationKey: setSprayWallTrainingConsentMutationKey(wallUuid) }) > 0;
}

/**
 * The wall's switch: true or false for its owner, null for anybody else (the
 * server withholds it) and while unknown. `enabled` is the caller's owner check,
 * so a moderator editing somebody's wall never asks.
 *
 * Retries are the client's default (`shouldRetryQuery`), which already gives up
 * at once on a backend that predates the field and asks twice more after a
 * dropped connection. Turning them off here cost the owner their only opt-out
 * control on one network blip.
 */
export function useSprayWallTrainingConsent(wallUuid: string, enabled: boolean) {
  return useQuery({
    queryKey: sprayWallTrainingConsentQueryKey(wallUuid),
    enabled,
    queryFn: async (): Promise<boolean | null> => {
      const response = await getHttpClient().request<GetSprayWallTrainingConsentQueryResponse>(
        GET_SPRAY_WALL_TRAINING_CONSENT,
        { uuid: wallUuid },
      );
      return response.sprayWall?.trainingConsent ?? null;
    },
  });
}

type SetSprayWallTrainingConsentOptions = {
  /**
   * The flip did not save. Called from the mutation's own `onError`, which runs
   * whether or not the switch is still on screen; a `mutate(_, { onError })`
   * callback is dropped once the caller unmounts, and the owner would never
   * learn their opt-out did not land.
   */
  onRefused: () => void;
};

/**
 * Flip one wall's switch. Optimistic, so the switch moves under the thumb; a
 * refusal puts the old value back and tells the caller.
 *
 * One flip at a time per wall. `setConsent` answers false, and sends nothing,
 * while an earlier flip is still on the wire: two overlapping flips that both
 * fail would otherwise restore the first one's optimistic value, leaving the
 * switch off over a wall that is still opted in. The check reads the mutation
 * cache, which is current the moment `mutate` returns, where a `disabled` prop
 * only lands a render later. Every flip then re-reads the wall, so the cache
 * ends on the server's value whatever happened in between.
 */
export function useSetSprayWallTrainingConsent(wallUuid: string, { onRefused }: SetSprayWallTrainingConsentOptions) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => sprayWallTrainingConsentQueryKey(wallUuid), [wallUuid]);
  const mutationKey = useMemo(() => setSprayWallTrainingConsentMutationKey(wallUuid), [wallUuid]);

  const { mutate } = useMutation({
    mutationKey,
    mutationFn: async (consent: boolean): Promise<boolean | null> => {
      const response = await getHttpClient().request<SetSprayWallTrainingConsentMutationResponse>(
        SET_SPRAY_WALL_TRAINING_CONSENT,
        { input: { uuid: wallUuid, trainingConsent: consent } },
      );
      return response.updateSprayWall.trainingConsent ?? null;
    },
    onMutate: async (consent) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<boolean | null>(queryKey);
      queryClient.setQueryData<boolean | null>(queryKey, consent);
      return { previous };
    },
    onError: (_error, _consent, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      onRefused();
    },
    onSuccess: (saved) => {
      if (saved != null) queryClient.setQueryData(queryKey, saved);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const isSaving = useSprayWallTrainingConsentSaving(wallUuid);
  const setConsent = useCallback(
    (consent: boolean): boolean => {
      if (isSprayWallTrainingConsentSaving(queryClient, wallUuid)) return false;
      mutate(consent);
      return true;
    },
    [queryClient, wallUuid, mutate],
  );

  return { setConsent, isSaving };
}
