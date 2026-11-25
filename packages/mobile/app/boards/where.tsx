// "Where's this board?" (#8151) became the add-a-board wizard's step 1
// (`/boards/add`). This route only redirects an old link or a stale screen:
// into the wizard with its flag on, to the builder with it off.
// TODO: delete this route one release after the add-board-wizard flag ships to
// everyone, with find-wall.tsx and src/lib/boards/legacy-board-routes.ts.

import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { wizardWhereHref } from '../../src/lib/boards/add-board-wizard';
import { legacyBuilderHref } from '../../src/lib/boards/legacy-board-routes';
import { useAddBoardWizardEnabled } from '../../src/providers/feature-flags-provider';

export default function BoardWhereRedirect() {
  const { returnTo, source } = useLocalSearchParams<{ returnTo?: string; source?: string }>();
  const router = useRouter();
  const wizardEnabled = useAddBoardWizardEnabled();
  useEffect(() => {
    router.replace(
      wizardEnabled ? wizardWhereHref({ returnTo, source, entry: 'link' }) : legacyBuilderHref({ returnTo, source }),
    );
    // Once, at mount: the flag as it reads now decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
