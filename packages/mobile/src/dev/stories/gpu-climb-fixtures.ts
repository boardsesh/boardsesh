import { getHoldDisplayColor, HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import {
  boardFieldColorForScheme,
  buildAuraRenderFields,
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  resolveVeilOpacity,
} from '@boardsesh/board-look';
import type { BoardArtGeometry, WallLightness } from '@boardsesh/board-art-geometry';
import type { HoldPlacement } from '../../components/board-renderer/types';

export const GPU_PARITY_BOARD = { boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: [26, 27] } as const;
export const GPU_PARITY_OUTPUT_WIDTH = 768;
export const GPU_PARITY_FLAG = 'gpu-climb-overlay-experiment';
export type GpuParityMode = 'compare' | 'rust' | 'metal';

/** Bounded deep-link inputs for repeatable simulator/device capture. */
export function gpuParityParameters(params: Record<string, string | string[] | undefined>) {
  const mode: GpuParityMode = params.mode === 'rust' || params.mode === 'metal' ? params.mode : 'compare';
  return {
    enabled: params.gpu === '1',
    sample: typeof params.sample === 'string' && /^[0-4]$/.test(params.sample) ? Number(params.sample) : 0,
    resolution: params.resolution === '512' ? 512 : params.resolution === '1024' ? 1024 : GPU_PARITY_OUTPUT_WIDTH,
    mode,
    verify: params.verify === '1',
  };
}

export type GpuParityFixture = { name: string; frames: string; holdCount: number };

/** Deterministic diagnostic climbs on real placements, never saved to the account. */
export function buildGpuParityFixtures(holds: readonly HoldPlacement[]): GpuParityFixture[] {
  if (holds.length < 30) throw new Error('The parity board needs at least 30 real holds.');
  const ordered = [...holds].sort(
    (first, second) => first.cy - second.cy || first.cx - second.cx || first.id - second.id,
  );
  const spread = (count: number) =>
    Array.from({ length: count }, (_, index) => ordered[Math.floor((index * (ordered.length - 1)) / (count - 1))]);
  let nearest = [ordered[0], ordered[1]];
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let first = 0; first < ordered.length; first++) {
    for (let second = first + 1; second < ordered.length; second++) {
      const distance = (ordered[first].cx - ordered[second].cx) ** 2 + (ordered[first].cy - ordered[second].cy) ** 2;
      if (distance > 0 && distance < minimumDistance) {
        minimumDistance = distance;
        nearest = [ordered[first], ordered[second]];
      }
    }
  }
  const fixture = (name: string, selected: readonly HoldPlacement[], roles: readonly number[]): GpuParityFixture => ({
    name,
    frames: selected.map((hold, index) => `p${hold.id}r${roles[index % roles.length]}`).join(''),
    holdCount: selected.length,
  });
  return [
    fixture('Sparse · 6 holds', spread(6), [44, 43, 43, 43, 42, 45]),
    fixture('Draft · 30 holds', spread(30), [42, 43, 44, 45]),
    fixture('Same-colour neighbours', nearest, [43]),
    fixture('Different-colour neighbours', nearest, [42, 44]),
    fixture('Empty', [], [43]),
  ];
}

export function buildGpuParityConfig({
  boardWidth,
  boardHeight,
  holds,
  geometry,
  wallLightness,
  colorScheme,
  frames,
  outputWidth = GPU_PARITY_OUTPUT_WIDTH,
}: {
  boardWidth: number;
  boardHeight: number;
  holds: readonly HoldPlacement[];
  geometry: BoardArtGeometry;
  wallLightness: WallLightness | null;
  colorScheme: 'light' | 'dark';
  frames: string;
  outputWidth?: number;
}) {
  const fieldColor = boardFieldColorForScheme(colorScheme);
  const settings = DEFAULT_BOARDSESH_RENDER_SETTINGS;
  return {
    board_width: boardWidth,
    board_height: boardHeight,
    output_width: Math.min(outputWidth, boardWidth),
    mirrored: false,
    thumbnail: false,
    stroke_width_multiplier: 1,
    shape_size_multiplier: 1,
    frames,
    // The complete, stable geometry makes the atlas reusable across fixtures.
    holds: holds.map((hold) => ({
      id: hold.id,
      mirrored_hold_id: hold.mirroredHoldId,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
      ...(geometry.outlines[hold.id] ? { outline: geometry.outlines[hold.id] } : {}),
      ...(geometry.ledInner?.[hold.id] ? { led_inner: geometry.ledInner[hold.id] } : {}),
      ...(geometry.silhouetteLightness[hold.id] !== undefined
        ? { silhouette_lightness: geometry.silhouetteLightness[hold.id] }
        : {}),
      ...(geometry.ledBright[hold.id] ? { led: geometry.ledBright[hold.id] } : {}),
    })),
    hold_state_map: Object.fromEntries(
      [42, 43, 44, 45].map((code) => {
        const role = HOLD_STATE_MAP.kilter[code];
        return [code, { color: getHoldDisplayColor(role, 'aura'), role: role.name.toLowerCase() }];
      }),
    ),
    ...buildAuraRenderFields({
      settings,
      boardName: 'kilter',
      glowFalloff: settings.glowFalloff,
      fieldColor,
      veilOpacity: resolveVeilOpacity(settings, wallLightness, fieldColor),
      thumbnail: false,
      hasLedOffsets: Object.keys(geometry.ledBright).length > 0,
    }),
  };
}

/** Delayed callbacks from a prior fixture must never label the new fixture. */
export function isCurrentGpuParityRequest(currentRequestId: string, eventRequestId: string): boolean {
  return currentRequestId === eventRequestId;
}
