// The add-a-board wizard's "Boards at {gym}" (gym path): the gym's walls
// (`GymWallList`), where an existing one is taken with Use this board
// (`useTakeExistingWall`) before a copy is added. "My board isn't listed" goes
// on to Set up with the gym locked and the type chosen here. A gym page's "Set
// up a board" opens the wizard here (`entry=gym_page`).

import { useMemo } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { toBoardName } from '@boardsesh/board-config';
import { GymWallList } from '../../../src/components/board-discovery/GymWallList';
import { isPickableBoardType } from '../../../src/lib/boards/find-wall-state';
import { useAddBoardWizardStep } from '../../../src/lib/boards/use-add-board-wizard-step';
import { wizardGymHref } from '../../../src/lib/boards/add-board-wizard';

export default function AddBoardGymBoards() {
  const params = useLocalSearchParams<{ gymUuid?: string; boardType?: string; returnTo?: string; source?: string }>();
  const gymUuid = typeof params.gymUuid === 'string' ? params.gymUuid : '';
  const parsedType = toBoardName(params.boardType);
  const initialBoardType = isPickableBoardType(parsedType) ? parsedType : null;
  const { entry, nextContext, stepLabel } = useAddBoardWizardStep({
    step: 'gym_boards',
    path: 'gym',
    abandonStep: 'find',
    abandonKind: 'gym',
  });
  const wizard = useMemo(() => ({ stepLabel, nextContext }), [stepLabel, nextContext]);

  // A link with no gym: find one first.
  if (!gymUuid) {
    return <Redirect href={wizardGymHref({ ...nextContext, trail: nextContext.trail.slice(0, -1) })} />;
  }

  return (
    <GymWallList
      gymUuid={gymUuid}
      initialBoardType={initialBoardType}
      returnTo={params.returnTo}
      source={params.source}
      entry={entry === 'gym_page' ? 'gym_page' : 'find_step'}
      wizard={wizard}
    />
  );
}
