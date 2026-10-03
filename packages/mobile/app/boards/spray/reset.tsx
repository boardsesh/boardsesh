// `/boards/spray/reset` — open the reset screen for the requested wall.
// A missing wall UUID returns to the picker; the screen checks ownership.

import { Redirect, useLocalSearchParams } from 'expo-router';
import { SprayWallResetScreen } from '../../../src/components/spray-wall/SprayWallResetScreen';
import { readSprayWallUuid } from '../../../src/lib/spray/spray-routes';

export default function ResetSprayWall() {
  const params = useLocalSearchParams<{ wallUuid?: string | string[]; boardUuid?: string | string[] }>();
  const wallUuid = readSprayWallUuid(params);
  if (!wallUuid) return <Redirect href="/boards" />;
  return <SprayWallResetScreen wallUuid={wallUuid} />;
}
