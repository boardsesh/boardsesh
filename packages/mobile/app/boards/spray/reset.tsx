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
import { useSprayWallsEnabled } from '../../../src/providers/feature-flags-provider';

export default function ResetSprayWall() {
  const params = useLocalSearchParams<{ wallUuid?: string }>();
  const enabled = useSprayWallsEnabled();

  // Unresolved flags read as off (`useSprayWallsEnabled`), so this also covers
  // the first frames of a cold open on a deep link: back to the picker, which is
  // a real screen, rather than a blank one.
  if (!enabled || !params.wallUuid) return <Redirect href="/boards" />;

  return <SprayWallResetScreen wallUuid={params.wallUuid} />;
}
