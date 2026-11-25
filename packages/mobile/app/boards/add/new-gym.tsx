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

import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { toBoardName } from '@boardsesh/board-config';
import type { Gym } from '@boardsesh/shared-schema';
import { NewGymStep } from '../../../src/components/board-discovery/new-gym-step/NewGymStep';
import { gymPageHref } from '../../../src/components/gym-page/gym-page-route';
import { isPickableBoardType } from '../../../src/lib/boards/find-wall-state';
import { wizardBoardHref, wizardGymBoardsHref, wizardSetupHref } from '../../../src/lib/boards/add-board-wizard';
import { useAddBoardWizardStep } from '../../../src/lib/boards/use-add-board-wizard-step';

export default function AddBoardNewGym() {
  const params = useLocalSearchParams<{ boardType?: string }>();
  const router = useRouter();
  const parsedType = toBoardName(params.boardType);
  const boardType = isPickableBoardType(parsedType) ? parsedType : null;
  const { nextContext, stepLabel, markHandedOff } = useAddBoardWizardStep({
    step: 'new_gym',
    path: 'gym',
    abandonStep: 'find',
    abandonKind: 'gym',
    boardTypeKnown: boardType !== null,
  });

  const onPickExistingGym = useCallback(
    (gymUuid: string) => router.push(wizardGymBoardsHref(nextContext, gymUuid, boardType)),
    [router, nextContext, boardType],
  );
  const onClaimGym = useCallback(
    (gymUuid: string) => router.push(gymPageHref(gymUuid, 'boards', nextContext.returnTo)),
    [router, nextContext.returnTo],
  );
  const onCreated = useCallback(
    (gym: Gym) => {
      // The next step takes the flow over (and its abandonment): this screen's
      // unmount is not the climber leaving.
      markHandedOff();
      router.replace(
        boardType
          ? wizardSetupHref(nextContext, { path: 'gym', boardType, gymUuid: gym.uuid })
          : wizardBoardHref(nextContext, 'gym', { gymUuid: gym.uuid }),
      );
    },
    [markHandedOff, router, nextContext, boardType],
  );
  const onSignInNeeded = useCallback(() => router.push('/auth/login'), [router]);

  return (
    <NewGymStep
      stepLabel={stepLabel}
      onPickExistingGym={onPickExistingGym}
      onClaimGym={onClaimGym}
      onCreated={onCreated}
      onSignInNeeded={onSignInNeeded}
    />
  );
}
