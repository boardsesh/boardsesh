// The add-a-board wizard's "Add your gym" (gym path): "Add my gym" on Which
// gym? opens it when the climber's gym isn't listed. They name it and pin it
// (`NewGymStep`); a gym they find is already listed goes to its boards as if
// picked on Which gym?, and Claim opens its page.
//
// Once the gym is created this screen REPLACES itself with the next step: Set
// up with the gym locked when the board type is known, else Which board?
// carrying the gym. Back from there then lands on Which gym?, where the new gym
// is now listed, never on a filled-in form whose Save would add a second copy.
// A guard inside the form also refuses a second Save while the first is out.
//
// While a save is out the screen can't be left (the back chevron, the iOS
// swipe and Android's back are held), so the gym and the flow never part. If
// it goes anyway (the whole Boards sheet closed), the save that lands later
// moves nothing: the gym is created, and Which gym? lists it next time. The
// flow is then reported once, as the gym created, never also as abandoned.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused, useLocalSearchParams, useNavigation, usePreventRemove, useRouter } from 'expo-router';
import { toBoardName } from '@boardsesh/board-config';
import type { Gym } from '@boardsesh/shared-schema';
import { NewGymStep } from '../../../src/components/board-discovery/new-gym-step/NewGymStep';
import { gymPageHref } from '../../../src/components/gym-page/gym-page-route';
import { isPickableBoardType } from '../../../src/lib/boards/find-wall-state';
import { wizardBoardHref, wizardGymBoardsHref, wizardSetupHref } from '../../../src/lib/boards/add-board-wizard';
import { useAddBoardWizardStep } from '../../../src/lib/boards/use-add-board-wizard-step';
import { openSignIn } from '../../../src/lib/routing/open-sign-in';

export default function AddBoardNewGym() {
  const params = useLocalSearchParams<{ boardType?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const parsedType = toBoardName(params.boardType);
  const boardType = isPickableBoardType(parsedType) ? parsedType : null;
  const { nextContext, stepLabel, markHandedOff, clearHandedOff } = useAddBoardWizardStep({
    step: 'new_gym',
    path: 'gym',
    abandonStep: 'find',
    abandonKind: 'gym',
    boardTypeKnown: boardType !== null,
  });

  // --- a save in flight holds the screen ---
  const [saving, setSaving] = useState(false);
  const disablePrevention = usePreventRemove(saving);
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !saving });
  }, [navigation, saving]);
  const isFocused = useIsFocused();
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const onSubmittingChange = useCallback(
    (submitting: boolean) => {
      setSaving(submitting);
      // While the save is out, leaving is not abandoning: the gym is on its way.
      if (submitting) markHandedOff();
      else clearHandedOff();
    },
    [markHandedOff, clearHandedOff],
  );

  // While a save is out, the listed gyms can't push another screen over this
  // one: that push isn't a removal, so the hold above wouldn't stop it, and the
  // save would then land on a screen that isn't in front.
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const onPickExistingGym = useCallback(
    (gymUuid: string) => {
      if (savingRef.current) return;
      router.push(wizardGymBoardsHref(nextContext, gymUuid, boardType));
    },
    [router, nextContext, boardType],
  );
  const onClaimGym = useCallback(
    (gymUuid: string) => {
      if (savingRef.current) return;
      router.push(gymPageHref(gymUuid, 'boards', nextContext.returnTo));
    },
    [router, nextContext.returnTo],
  );
  const handOff = useCallback(
    (gymUuid: string) => {
      // The next step takes the flow over (and its abandonment): this screen's
      // unmount is not the climber leaving.
      markHandedOff();
      setSaving(false);
      disablePrevention();
      router.replace(
        boardType
          ? wizardSetupHref(nextContext, { path: 'gym', boardType, gymUuid })
          : wizardBoardHref(nextContext, 'gym', { gymUuid }),
      );
    },
    [markHandedOff, disablePrevention, router, nextContext, boardType],
  );
  // A save that landed while another screen was in front: the gym exists, so
  // finish the hand-off when this screen is back in front instead of leaving a
  // form stuck on "saving".
  const createdWhileCoveredRef = useRef<string | null>(null);
  const onCreated = useCallback(
    (gym: Gym) => {
      // Gone: the save landed after the climber left. Move nothing.
      if (!mountedRef.current) return;
      if (!isFocusedRef.current) {
        createdWhileCoveredRef.current = gym.uuid;
        return;
      }
      handOff(gym.uuid);
    },
    [handOff],
  );
  useEffect(() => {
    const createdGymUuid = createdWhileCoveredRef.current;
    if (!isFocused || createdGymUuid === null) return;
    createdWhileCoveredRef.current = null;
    handOff(createdGymUuid);
  }, [isFocused, handOff]);
  const onSignInNeeded = useCallback(() => openSignIn(router, 'boards'), [router]);

  return (
    <NewGymStep
      stepLabel={stepLabel}
      onPickExistingGym={onPickExistingGym}
      onClaimGym={onClaimGym}
      onCreated={onCreated}
      onSignInNeeded={onSignInNeeded}
      onSubmittingChange={onSubmittingChange}
    />
  );
}
