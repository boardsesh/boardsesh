// `/boards/spray/new` — the add-a-wall front door (epic #5346, SW-09).
//
// Thin on purpose: resolve where the flow should dismiss back to, check the two
// gates, and hand over to the wizard. Everything with an opinion lives in
// `SprayWallWizardScreen`, which is a component rather than a route so its steps
// can be exercised without a router.
//
// The flag gate is a REDIRECT rather than a hidden tile, because a tile is not
// the only way in: a deep link, a restored navigation state or a stale tab all
// reach a route directly, and a dark feature has to be dark from every door.

import { Redirect, useLocalSearchParams } from 'expo-router';
import { SprayWallWizardScreen } from '../../../src/components/spray-wall/SprayWallWizardScreen';
import { useFeatureFlagsResolved, useSprayWallsEnabled } from '../../../src/providers/feature-flags-provider';
import { resolveBoardReturnTo } from '../../../src/lib/boards/board-return-to';

export default function NewSprayWall() {
  const params = useLocalSearchParams<{ returnTo?: string }>();
  const flagsResolved = useFeatureFlagsResolved();
  const enabled = useSprayWallsEnabled();

  // Nothing at all until the flags are final. `useSprayWallsEnabled` reads an
  // unresolved flag as OFF, which is right for a tile — it stays hidden and
  // appears when the value lands — and wrong here: a redirect is not something a
  // later value can undo, so a climber the feature IS enabled for would be
  // bounced off their own deep link before PostHog ever answered. The wait is
  // bounded by the provider's own timeout.
  if (!flagsResolved) return null;
  if (!enabled) return <Redirect href="/boards" />;

  return <SprayWallWizardScreen returnTo={resolveBoardReturnTo(params.returnTo)} />;
}
