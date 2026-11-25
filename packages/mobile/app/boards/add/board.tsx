// The add-a-board wizard's "Which board?" (`BoardTypeStep`). On the home path it
// follows "At home" (or first run's inline At home); on the gym path it follows
// "Add my gym" when no board type was chosen on the map. A tap opens Set up on
// that type's most used setup.

import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { BoardName } from '@boardsesh/shared-schema';
import { BoardTypeStep } from '../../../src/components/board-discovery/add-board-wizard/BoardTypeStep';
import { usePopularBoardConfigs } from '../../../src/lib/graphql/hooks';
import { parseWizardPath, wizardSetupHref } from '../../../src/lib/boards/add-board-wizard';
import { useAddBoardWizardStep } from '../../../src/lib/boards/use-add-board-wizard-step';

export default function AddBoardType() {
  const params = useLocalSearchParams<{ path?: string; focusLocation?: string }>();
  const router = useRouter();
  const path = parseWizardPath(params.path) === 'gym' ? 'gym' : 'home';
  const focusLocation = params.focusLocation === '1';
  const { nextContext, stepLabel } = useAddBoardWizardStep({
    step: 'board',
    path,
    abandonStep: 'board',
    abandonKind: path,
  });
  // The same list Set up presets from, so a tile shows the board it opens on.
  const { data: popularConfigs } = usePopularBoardConfigs({ limit: 12 });

  const onPick = useCallback(
    (boardType: BoardName) => router.push(wizardSetupHref(nextContext, { path, boardType, focusLocation })),
    [router, nextContext, path, focusLocation],
  );

  return <BoardTypeStep stepLabel={stepLabel} popularConfigs={popularConfigs?.configs} onPick={onPick} />;
}
