import { Redirect, useLocalSearchParams } from 'expo-router';
import { SprayWallLedSetupScreen } from '../../../src/components/spray-wall/SprayWallLedSetupScreen';
import { readSprayWallUuid } from '../../../src/lib/spray/spray-routes';

export default function SprayWallLedSetupRoute() {
  const params = useLocalSearchParams<{ wallUuid?: string | string[] }>();
  const wallUuid = readSprayWallUuid(params);
  if (!wallUuid) return <Redirect href="/boards" />;
  return <SprayWallLedSetupScreen key={wallUuid} wallUuid={wallUuid} />;
}
