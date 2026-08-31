import { MAX_ACTIVE_BOARD_LAYERS } from './layers';

export type BoardLayerPresence = {
  color: string;
  remainingSeconds: number;
  climbUuid?: string | null;
  angle?: number | null;
  geometryKnown: boolean;
};

export type BoardLayersPresenceSnapshot = {
  sequence: number;
  observedAt: string;
  stale: boolean;
  layers: BoardLayerPresence[];
};

export type ControllerLayerForPresence = {
  red: number;
  green: number;
  blue: number;
  remainingSeconds: number;
  resolvedClimbUuid?: string | null;
  angle?: number | null;
  geometryKnown: boolean;
};

function colorByte(value: number): number {
  return Math.min(255, Math.max(0, Math.trunc(value)));
}

function toColor(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((component) => colorByte(component).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Produce the only layer shape allowed over the party-presence boundary. The
 * controller user UUID and route UUID are deliberately absent from both input
 * mapping and output, preventing accidental persistence or analytics capture.
 */
export function sanitizeBoardLayersPresence(
  layers: readonly ControllerLayerForPresence[],
  sequence: number,
  observedAt: string,
  stale = false,
): BoardLayersPresenceSnapshot {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Layer sequence must be a non-negative integer');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Layer observedAt must be an ISO timestamp');
  if (layers.length > MAX_ACTIVE_BOARD_LAYERS) throw new Error('A board can report at most four layers');

  return {
    sequence,
    observedAt,
    stale,
    layers: layers.map((layer) => ({
      color: toColor(layer.red, layer.green, layer.blue),
      remainingSeconds: Math.min(65_535, Math.max(0, Math.trunc(layer.remainingSeconds))),
      climbUuid: layer.resolvedClimbUuid ?? null,
      angle: layer.angle == null ? null : Math.trunc(layer.angle),
      geometryKnown: layer.geometryKnown,
    })),
  };
}
