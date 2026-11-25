// "Find your gym's board" (#8151) became the add-a-board wizard's gym steps:
// "Which gym?" (`/boards/add/gym`) and, with `gymUuid`, "Boards at {gym}"
// (`/boards/add/gym-boards`). This route only redirects an old link or a stale
// screen: into the wizard with its flag on, to the builder with it off.
// TODO: delete this route one release after the add-board-wizard flag ships to
// everyone, with where.tsx and src/lib/boards/legacy-board-routes.ts.

import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { findWallRedirectHref, legacyBuilderHref } from '../../src/lib/boards/legacy-board-routes';
import { useAddBoardWizardEnabled } from '../../src/providers/feature-flags-provider';

export default function FindWallRedirect() {
  const params = useLocalSearchParams<{
    gymUuid?: string;
    boardType?: string;
    returnTo?: string;
    source?: string;
    entry?: string;
  }>();
  const router = useRouter();
  const wizardEnabled = useAddBoardWizardEnabled();
  useEffect(() => {
    router.replace(
      wizardEnabled
        ? findWallRedirectHref(params)
        : legacyBuilderHref({ returnTo: params.returnTo, source: params.source }),
    );
    // Once, at mount: the flag as it reads now decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
