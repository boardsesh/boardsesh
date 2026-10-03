import { Redirect, useLocalSearchParams } from 'expo-router';
import { SprayWallHoldsScreen } from '../../../src/components/spray-wall/SprayWallHoldsScreen';
import { readSprayWallUuid } from '../../../src/lib/spray/spray-routes';
import { useFeatureFlagsResolved, useSprayWallsEnabled } from '../../../src/providers/feature-flags-provider';

export default function EditSprayWallHolds() {
  const params = useLocalSearchParams<{ wallUuid?: string | string[]; boardUuid?: string | string[] }>();
  const flagsResolved = useFeatureFlagsResolved();
  const enabled = useSprayWallsEnabled();
  if (!flagsResolved) return null;
  const wallUuid = readSprayWallUuid(params);
  if (!enabled || !wallUuid) return <Redirect href="/boards" />;
  return <SprayWallHoldsScreen wallUuid={wallUuid} />;
}
