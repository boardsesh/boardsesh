// The add-a-board wizard's "Which gym?" (gym path): the map and search of
// `GymStep`. A gym picked goes to its boards; "Add my gym" (the gym isn't
// listed) goes to Which board? when no type is chosen yet, else straight to
// Set up, with More options' location field focused so the climber says where
// the gym is. Adding needs an account.

import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardName, Gym } from '@boardsesh/shared-schema';
import { GymStep } from '../../../src/components/board-discovery/gym-step/GymStep';
import { isPickableBoardType } from '../../../src/lib/boards/find-wall-state';
import {
  trailThrough,
  wizardBoardHref,
  wizardGymBoardsHref,
  wizardSetupHref,
} from '../../../src/lib/boards/add-board-wizard';
import { useAddBoardWizardStep } from '../../../src/lib/boards/use-add-board-wizard-step';
import { useAuth } from '../../../src/providers/auth-provider';
import { openSignIn } from '../../../src/lib/routing/open-sign-in';

export default function AddBoardGym() {
  const params = useLocalSearchParams<{ boardType?: string }>();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const parsedType = toBoardName(params.boardType);
  const initialBoardType = isPickableBoardType(parsedType) ? parsedType : null;
  const { nextContext, stepLabel } = useAddBoardWizardStep({
    step: 'gym',
    path: 'gym',
    abandonStep: 'find',
    abandonKind: 'gym',
  });

  const onPickGym = useCallback(
    (gym: Gym, boardType: BoardName | null) => router.push(wizardGymBoardsHref(nextContext, gym.uuid, boardType)),
    [router, nextContext],
  );
  const onAddGym = useCallback(
    (boardType: BoardName | null) => {
      if (!isAuthenticated) {
        // In place of the picker, never a card on top of it (open-sign-in.ts).
        openSignIn(router, 'boards');
        return;
      }
      // The type picked on the map's capsule stands for Which board?, so it
      // counts as that step: Set up is still step 4 of 4, as this screen's
      // "Step 2 of 4" promised.
      router.push(
        boardType
          ? wizardSetupHref(
              { ...nextContext, trail: trailThrough(nextContext.trail, 'board') },
              { path: 'gym', boardType, focusLocation: true },
            )
          : wizardBoardHref(nextContext, 'gym', { focusLocation: true }),
      );
    },
    [isAuthenticated, router, nextContext],
  );

  return (
    <GymStep
      stepLabel={stepLabel ?? undefined}
      initialBoardType={initialBoardType}
      onPickGym={onPickGym}
      onAddGym={onAddGym}
    />
  );
}
