export const MAX_ACTIVE_BOARD_LAYERS = 4;
export const MAX_DIODES_PER_LAYER = 92;

export const BOARD_LAYER_COLORS = [
  { key: 'green', red: 0, green: 255, blue: 0, hex: '#00FF00' },
  { key: 'cyan', red: 0, green: 255, blue: 255, hex: '#00FFFF' },
  { key: 'magenta', red: 255, green: 0, blue: 255, hex: '#FF00FF' },
  { key: 'yellow', red: 255, green: 255, blue: 0, hex: '#FFFF00' },
] as const;

export type BoardLayerColorKey = (typeof BOARD_LAYER_COLORS)[number]['key'];
export type BoardLayerColor = (typeof BOARD_LAYER_COLORS)[number];

export type InstallationBoardLayer = {
  slot: number;
  controllerUserUuid: string;
  color: BoardLayerColor;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bind four install-local identities to the four fixed layer colours. These
 * identities are physical-controller credentials: callers must keep them in
 * device storage and must never send them to the server or analytics.
 */
export function buildInstallationBoardLayers(controllerUserUuids: readonly string[]): InstallationBoardLayer[] {
  if (controllerUserUuids.length !== MAX_ACTIVE_BOARD_LAYERS) {
    throw new Error(`Expected ${MAX_ACTIVE_BOARD_LAYERS} controller user UUIDs`);
  }
  const normalized = controllerUserUuids.map((uuid) => uuid.toLowerCase());
  if (new Set(normalized).size !== MAX_ACTIVE_BOARD_LAYERS || normalized.some((uuid) => !UUID_PATTERN.test(uuid))) {
    throw new Error('Controller user UUIDs must be four distinct RFC 4122 UUIDs');
  }
  return normalized.map((controllerUserUuid, slot) => ({
    slot,
    controllerUserUuid,
    color: BOARD_LAYER_COLORS[slot],
  }));
}

export type ControllerLayerPlayer = {
  controllerUserUuid: string;
  controllerRouteUuid: string;
  red: number;
  green: number;
  blue: number;
  remainingSeconds: number;
};

export function sameControllerPlayer(left: ControllerLayerPlayer, right: ControllerLayerPlayer): boolean {
  return (
    left.controllerUserUuid.toLowerCase() === right.controllerUserUuid.toLowerCase() &&
    left.controllerRouteUuid.toLowerCase() === right.controllerRouteUuid.toLowerCase() &&
    left.red === right.red &&
    left.green === right.green &&
    left.blue === right.blue
  );
}

export function controllerRostersEqual(
  left: readonly ControllerLayerPlayer[],
  right: readonly ControllerLayerPlayer[],
): boolean {
  if (left.length !== right.length) return false;
  const byUser = new Map(left.map((player) => [player.controllerUserUuid.toLowerCase(), player]));
  return right.every((player) => {
    const previous = byUser.get(player.controllerUserUuid.toLowerCase());
    return previous !== undefined && sameControllerPlayer(previous, player);
  });
}
