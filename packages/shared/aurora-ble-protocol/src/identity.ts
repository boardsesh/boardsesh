export const AURORA_BOARDS = ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'] as const;
export type AuroraBoardName = (typeof AURORA_BOARDS)[number];

// --- Device name parsing ---

/**
 * Parse Aurora BLE device name to extract API level.
 * Format: {DisplayName}#{SerialNumber}@{APILevel}
 * Default API level is 2 if not specified.
 */
export const parseApiLevel = (deviceName?: string): number => {
  if (!deviceName) return 2;
  const match = deviceName.match(/@(\d+)/);
  return match ? parseInt(match[1], 10) : 2;
};

/**
 * Parse Aurora BLE device name to extract the serial number.
 * Format: {DisplayName}#{SerialNumber}@{APILevel}
 * Returns undefined if no serial found.
 */
export const parseSerialNumber = (deviceName?: string): string | undefined => {
  if (!deviceName) return undefined;
  const match = deviceName.match(/#([^@]+)/);
  return match ? match[1] : undefined;
};

/**
 * Infer the board type from a BLE device name.
 * e.g. "Kilter Board#751737@3" -> 'kilter', "Tension Board#123@2" -> 'tension', "So iLL Board#42@3" -> 'soill'.
 * Supports all Aurora boards: kilter, tension, decoy, touchstone, grasshopper, soill.
 * Whitespace and hyphens are stripped before matching so the multi-word "So iLL Board" name resolves.
 */
export const parseBoardTypeFromDeviceName = (deviceName?: string): AuroraBoardName | undefined => {
  if (!deviceName) return undefined;
  const normalized = deviceName.toLowerCase().replace(/[\s-]/g, '');
  return AURORA_BOARDS.find((board) => normalized.startsWith(board));
};

/**
 * True for a "Kilter-built" (manufacturer-built) LED box: an Aurora-family board
 * that advertises WITHOUT the `#serial@apiLevel` suffix (a bare name like
 * "Kilter Board"). These mid-2025+ boxes expose a UART RX characteristic with
 * only the `.write` property — the official Kilter app drives every box with
 * write-WITH-response, and iOS/CoreBluetooth silently drops a no-response write
 * to such a characteristic, so the wall stays dark. Detecting the box by its
 * bare name lets the client start on write-with-response from the first connect
 * instead of eating a stall first.
 *
 * This is a NAME signal, not the GATT property bit: a healthy box that carries a
 * serial (`Kilter Board#751737@3`) never matches, so it keeps the faster
 * without-response path — this cannot re-introduce the #3228 stale-property
 * regression, which was driven by the characteristic's `.writeWithoutResponse`
 * bit, not the advertised name.
 */
export const isKilterBuiltBox = (deviceName?: string): boolean =>
  parseBoardTypeFromDeviceName(deviceName) !== undefined && parseSerialNumber(deviceName) === undefined;
