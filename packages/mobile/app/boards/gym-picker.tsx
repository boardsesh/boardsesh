// The builders' gym row (Edit board, Set up, a spray wall's details): the gym
// step in pick mode, pushed in the board picker's stack. It used to be a
// searchable list in a sheet, a sheet on the Boards sheet
// (docs/mobile/mobile-sheets-vs-routes.md). A choice is handed back to the form
// that pushed it (gym-pick-handoff.ts) and the screen goes back. Opened with
// nobody to hand it to (a bare link), it goes back, or to the wizard's step 1
// when there is nothing to go back to.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Gym } from '@boardsesh/shared-schema';
import { GymStep, type GymStepPicker } from '../../src/components/board-discovery/gym-step/GymStep';
import { emitGymPick, readGymPickerParams, type GymPick } from '../../src/lib/boards/gym-pick-handoff';
import { hapticSelection } from '../../src/lib/haptics';

export default function BoardGymPicker() {
  const params = useLocalSearchParams<{
    handoffId?: string;
    gymUuid?: string;
    latitude?: string;
    longitude?: string;
    showsOnMap?: string;
  }>();
  const router = useRouter();
  const { handoffId: handoffParam, gymUuid, latitude, longitude, showsOnMap: showsOnMapParam } = params;
  const { handoffId, currentGymUuid, boardCoords, showsOnMap } = useMemo(
    () => readGymPickerParams({ handoffId: handoffParam, gymUuid, latitude, longitude, showsOnMap: showsOnMapParam }),
    [handoffParam, gymUuid, latitude, longitude, showsOnMapParam],
  );

  const unusable = handoffId === '';
  useEffect(() => {
    if (!unusable) return;
    if (router.canGoBack()) router.back();
    else router.replace('/boards/add');
    // Once, at mount: the params cannot change while it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One answer per visit: a second tap while the screen is leaving would hand
  // a second pick back and pop the builder under it too.
  const handedBackRef = useRef(false);
  const handBack = useCallback(
    (pick: GymPick) => {
      if (handedBackRef.current) return;
      handedBackRef.current = true;
      hapticSelection();
      emitGymPick(handoffId, pick);
      router.back();
    },
    [handoffId, router],
  );
  const onPickGym = useCallback(
    (gym: Gym) =>
      handBack({
        kind: 'gym',
        gym: { uuid: gym.uuid, name: gym.name, latitude: gym.latitude, longitude: gym.longitude },
      }),
    [handBack],
  );
  const onNotListed = useCallback(() => handBack({ kind: 'not_listed' }), [handBack]);
  const onPickNone = useCallback(() => handBack({ kind: 'none' }), [handBack]);

  const picker = useMemo<GymStepPicker>(
    () => ({ currentGymUuid, showsOnMap, initialCenter: boardCoords, onPickNone }),
    [currentGymUuid, showsOnMap, boardCoords, onPickNone],
  );

  if (unusable) return null;

  return <GymStep picker={picker} onPickGym={onPickGym} onAddGym={onNotListed} />;
}
