import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  createGymPickHandoffId,
  gymPickerHref,
  subscribeToGymPicks,
  type GymPick,
  type GymPickerContext,
} from './gym-pick-handoff';

/**
 * A builder form's gym row: pushes the gym picker (`/boards/gym-picker`) and
 * hands what the climber chose there to `onPick`, for this form only. Returns
 * the row's tap handler.
 */
export function useGymPickerRoute({
  currentGymUuid,
  boardCoords,
  showsOnMap,
  onPick,
}: Omit<GymPickerContext, 'handoffId'> & { onPick: (pick: GymPick) => void }): () => void {
  const router = useRouter();
  const [handoffId] = useState(createGymPickHandoffId);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  useEffect(() => subscribeToGymPicks(handoffId, (pick) => onPickRef.current(pick)), [handoffId]);

  return useCallback(() => {
    router.push(gymPickerHref({ handoffId, currentGymUuid, boardCoords, showsOnMap }));
  }, [router, handoffId, currentGymUuid, boardCoords, showsOnMap]);
}
