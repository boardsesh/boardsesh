// `/boards/spray/new` — resolve the return destination and open the wizard.
// The wizard owns authentication and draft recovery.

import { useLocalSearchParams } from 'expo-router';
import { SprayWallWizardScreen } from '../../../src/components/spray-wall/SprayWallWizardScreen';
import { resolveBoardReturnTo } from '../../../src/lib/boards/board-return-to';

export default function NewSprayWall() {
  const params = useLocalSearchParams<{ returnTo?: string; wallUuid?: string; versionId?: string }>();
  return (
    <SprayWallWizardScreen
      returnTo={resolveBoardReturnTo(params.returnTo)}
      wallUuid={params.wallUuid}
      versionId={params.versionId}
    />
  );
}
