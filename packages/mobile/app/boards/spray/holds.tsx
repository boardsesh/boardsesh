import { Redirect, useLocalSearchParams } from 'expo-router';
import { SprayWallHoldsScreen } from '../../../src/components/spray-wall/SprayWallHoldsScreen';
import { readSprayWallUuid } from '../../../src/lib/spray/spray-routes';

export default function EditSprayWallHolds() {
  const params = useLocalSearchParams<{
    wallUuid?: string | string[];
    boardUuid?: string | string[];
    putBack?: string | string[];
  }>();
  const wallUuid = readSprayWallUuid(params);
  if (!wallUuid) return <Redirect href="/boards" />;
  // Set when a climb editor sent the owner here to put a removed hold back (#5493).
  const putBackRequestId = typeof params.putBack === 'string' ? params.putBack : null;
  return <SprayWallHoldsScreen wallUuid={wallUuid} putBackRequestId={putBackRequestId} />;
}
