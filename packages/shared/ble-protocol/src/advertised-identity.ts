import { parseBoardTypeFromDeviceName, type AuroraBoardName } from './aurora';
import { isMoonboardDeviceName } from './moonboard';
import { isWoodsDeviceName } from './woods';

/** Name identity is independent of the packet encoder a board uses. */
export function parseAnyBoardTypeFromDeviceName(
  deviceName?: string,
): AuroraBoardName | 'moonboard' | 'woods' | undefined {
  if (!deviceName) return undefined;
  if (isMoonboardDeviceName(deviceName)) return 'moonboard';
  if (isWoodsDeviceName(deviceName)) return 'woods';
  return parseBoardTypeFromDeviceName(deviceName);
}
