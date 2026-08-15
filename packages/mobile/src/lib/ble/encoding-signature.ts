import { isMoonboardBoardName } from '@boardsesh/board-config';

const DEFAULT_BLE_ENCODING_SIGNATURE = 'default';
const MOONBOARD_ADJACENT_HOLDS_ENCODING_SIGNATURE = 'moonboard:adjacent-holds';

/**
 * Identity of packet-encoding preferences that can change the physical LEDs
 * produced by otherwise identical climb frames. The adjacent-hold preference
 * is global, but only changes MoonBoard packets; keeping Aurora on the default
 * signature avoids a redundant wall write when that preference hydrates or is
 * changed off a MoonBoard route.
 */
export function getBleEncodingSignature(
  boardName: string | null | undefined,
  moonboardLightAdjacentHolds: boolean,
): string {
  return isMoonboardBoardName(boardName) && moonboardLightAdjacentHolds
    ? MOONBOARD_ADJACENT_HOLDS_ENCODING_SIGNATURE
    : DEFAULT_BLE_ENCODING_SIGNATURE;
}
