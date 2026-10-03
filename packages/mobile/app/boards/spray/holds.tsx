import { Redirect, useLocalSearchParams } from 'expo-router';
import { SprayWallHoldsScreen } from '../../../src/components/spray-wall/SprayWallHoldsScreen';
import { readSprayWallUuid } from '../../../src/lib/spray/spray-routes';

export default function EditSprayWallHolds() {
  const params = useLocalSearchParams<{ wallUuid?: string | string[]; boardUuid?: string | string[] }>();
  const wallUuid = readSprayWallUuid(params);
  if (!wallUuid) return <Redirect href="/boards" />;
  return <SprayWallHoldsScreen wallUuid={wallUuid} />;
}
