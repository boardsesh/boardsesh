// The add-a-board wizard's "Which gym?" (gym path): the map and search of
// `GymStep`. A gym picked goes to its boards; "Add my gym" (the gym isn't
// listed) goes to Add your gym, carrying the type chosen on the map. Adding
// needs an account.

import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardName, Gym } from '@boardsesh/shared-schema';
import { GymStep } from '../../../src/components/board-discovery/gym-step/GymStep';
import { isPickableBoardType } from '../../../src/lib/boards/find-wall-state';
import { wizardGymBoardsHref, wizardNewGymHref } from '../../../src/lib/boards/add-board-wizard';
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
      router.push(wizardNewGymHref(nextContext, boardType));
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
