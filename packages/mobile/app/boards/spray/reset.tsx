// `/boards/spray/reset` — the reset front door (epic #5346, SW-13).
//
// Thin on purpose, and the same shape as `/boards/spray/new`: check the two
// gates and hand over to the screen. Everything with an opinion lives in
// `SprayWallResetScreen`, which is a component rather than a route so its steps
// can be exercised without a router.
//
// The flag gate is a REDIRECT rather than a hidden row, because a row is not the
// only way in: a deep link, a restored navigation state or a stale tab all reach
// a route directly, and a dark feature has to be dark from every door. A missing
// `wallUuid` lands in the same place — this route means nothing without one.

import { Redirect, useLocalSearchParams } from 'expo-router';
import { SprayWallResetScreen } from '../../../src/components/spray-wall/SprayWallResetScreen';
import { useFeatureFlagsResolved, useSprayWallsEnabled } from '../../../src/providers/feature-flags-provider';
import { readSprayWallUuid } from '../../../src/lib/spray/spray-routes';

export default function ResetSprayWall() {
  const params = useLocalSearchParams<{ wallUuid?: string | string[]; boardUuid?: string | string[] }>();
  const wallUuid = readSprayWallUuid(params);
  const flagsResolved = useFeatureFlagsResolved();
  const enabled = useSprayWallsEnabled();

  // Wait for bounded resolution before redirecting. Spray walls ship on, but
  // an explicit Off override must land before a deep link opens editing.
  if (!flagsResolved) return null;
  if (!enabled || !wallUuid) return <Redirect href="/boards" />;

  return <SprayWallResetScreen wallUuid={wallUuid} />;
}
