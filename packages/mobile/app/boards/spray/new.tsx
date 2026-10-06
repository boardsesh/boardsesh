// `/boards/spray/new` — resolve the return destination and open the wizard.
// The wizard owns authentication and draft recovery. `?resetOf=<wallUuid>` opens
// it as that wall's reset: it builds the replacement instead of a new wall.

import { useLocalSearchParams } from 'expo-router';
import { SprayWallWizardScreen } from '../../../src/components/spray-wall/SprayWallWizardScreen';
import { resolveBoardReturnTo } from '../../../src/lib/boards/board-return-to';
import { readSprayResetSource } from '../../../src/lib/spray/spray-routes';

export default function NewSprayWall() {
  const params = useLocalSearchParams<{
    returnTo?: string;
    resetOf?: string | string[];
    resetSource?: string | string[];
  }>();
  const resetOfWallUuid =
    typeof params.resetOf === 'string' && params.resetOf.trim().length > 0 ? params.resetOf : null;
  return (
    <SprayWallWizardScreen
      returnTo={resolveBoardReturnTo(params.returnTo)}
      resetOfWallUuid={resetOfWallUuid}
      resetSource={readSprayResetSource(params.resetSource)}
    />
  );
}
