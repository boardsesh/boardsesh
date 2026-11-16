// `/boards/spray/new` — resolve the return destination and open the wizard.
// The wizard owns authentication and draft recovery. `?resetOf=<wallUuid>` opens
// it as that wall's reset: it builds the replacement instead of a new wall.
// `?source=onboarding` (from the first-run picker) makes the wall's bind close
// out first run, as the builder's does.

import { useLocalSearchParams } from 'expo-router';
import { SprayWallWizardScreen } from '../../../src/components/spray-wall/SprayWallWizardScreen';
import { resolveBoardReturnTo } from '../../../src/lib/boards/board-return-to';

export default function NewSprayWall() {
  const params = useLocalSearchParams<{
    returnTo?: string;
    source?: string;
    resetOf?: string | string[];
    wallUuid?: string;
    versionId?: string;
  }>();
  const resetOfWallUuid =
    typeof params.resetOf === 'string' && params.resetOf.trim().length > 0 ? params.resetOf : null;
  return (
    <SprayWallWizardScreen
      returnTo={resolveBoardReturnTo(params.returnTo)}
      source={params.source === 'onboarding' ? 'onboarding' : undefined}
      resetOfWallUuid={resetOfWallUuid}
      wallUuid={params.wallUuid}
      versionId={params.versionId}
    />
  );
}
