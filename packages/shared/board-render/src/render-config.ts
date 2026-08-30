import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardStrokeWidthMultiplier, parseFramesSegments } from '@boardsesh/board-constants/hold-states';
import { OG_BOARD_PADDING_X, OG_BOARD_PADDING_Y } from './background';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';
import type {
  GlowFalloff,
  HoldRole,
  HoldStateRecord,
  MarkStyle,
  RenderableBoardDetails,
  RenderMode,
  VeilConfig,
  WasmRenderConfig,
  WasmRenderHold,
} from './types';

/** Thumbnail render width in pixels. Covers 3x retina at ~64px CSS display. */
export const THUMBNAIL_WIDTH = 200;

/**
 * Per-hold silhouette geometry for `boardsesh` mode, keyed by hold id. Every
 * field is optional and this whole param is optional — `@boardsesh/board-art-geometry`
 * (issue #2202) is the eventual source and isn't wired in yet, so this is a
 * structural injection point: pass it once that package ships, and boardsesh
 * mode keeps rendering veil + glow with no traced outlines until then.
 */
export type HoldGeometryInput = {
  /** Flat `[x0, y0, x1, y1, …]` outline per hold, in units of `r` relative to its centre. */
  outlines?: Record<number, number[]>;
  /**
   * Inner boundary of the LED base plate per hold, same form and units as
   * `outlines`. Where it exists the renderer lights the ring between the two —
   * the plate a real LED shines through — instead of the whole silhouette.
   * Rare and hand-traced: a hold that is absent from it lights whole.
   */
  ledInner?: Record<number, number[]>;
  /** `[dx, dy]` LED position offset per hold, in units of `r` relative to its centre. */
  ledBright?: Record<number, [number, number]>;
  /** 0–1 lightness of the board photo under each hold's silhouette. */
  silhouetteLightness?: Record<number, number>;
};

type BuildRenderConfigParams = {
  boardName: string;
  boardDetails: RenderableBoardDetails;
  frames: string;
  thumbnail: boolean;
  isOgVariant: boolean;
  /** Per-board hold-state colour/style map (from HOLD_STATE_MAP[boardName]). */
  boardStates: HoldStateRecord;
  /** Injected so web can pass its (mockable) THUMBNAIL_WIDTH; defaults to the shared constant. */
  thumbnailWidth?: number;
  /** "boardsesh" draws the veil + glow treatment; omitted/"classic" renders exactly as today (issue #2202). */
  renderMode?: RenderMode;
  /** `boardsesh` mode only. Renderer defaults to "soft" when omitted. */
  glowFalloff?: GlowFalloff;
  /** `boardsesh` mode only: role glyphs inside the glow. Defaults to off. */
  glyphs?: boolean;
  /** `boardsesh` mode only: translucent wash over the whole board. */
  veil?: VeilConfig;
  /** `boardsesh` mode only. Renderer defaults to "glow" (or "glow-fill" for thumbnails) when omitted. */
  markStyle?: MarkStyle;
  /** `boardsesh` mode only — see `HoldGeometryInput`. */
  holdGeometry?: HoldGeometryInput;
};

export type RenderConfigResult = {
  config: WasmRenderConfig;
  outputWidth: number;
  ogScale: number | null;
};

/** `HoldStateInfo.name` values `boardsesh` mode maps onto a per-role render treatment. */
const BOARDSESH_ROLE_NAMES = new Set(['STARTING', 'HAND', 'FINISH', 'FOOT']);

function roleForHoldStateName(name: string | undefined): HoldRole | undefined {
  if (!name || !BOARDSESH_ROLE_NAMES.has(name)) return undefined;
  return name.toLowerCase() as HoldRole;
}

/**
 * Hold ids lit in the render's first frame — `p<id>r<code>` pairs from the
 * leading comma-separated segment. Frame 0 of an Aurora frames string is
 * always an absolute snapshot (see `parseFramesSegments`), so a plain regex
 * over its body is enough: there is no prior-frame state to fold in and no
 * `x<id>` removal to reconcile within frame 0 itself.
 */
function litHoldIdsFromFirstFrame(frames: string): Set<number> {
  const firstFrameBody = parseFramesSegments(frames)[0]?.body ?? '';
  const litHoldIds = new Set<number>();
  const holdRolePattern = /p(\d+)r\d+/g;
  let match: RegExpExecArray | null;
  while ((match = holdRolePattern.exec(firstFrameBody)) !== null) {
    litHoldIds.add(Number(match[1]));
  }
  return litHoldIds;
}

/**
 * Assemble the WASM render config for a climb: computes the output width
 * (OG-scaled, thumbnail, or native), builds the hold-state colour map, and
 * emits the config object the overlay renderer consumes. Pure — no I/O.
 */
export function buildRenderConfig({
  boardName,
  boardDetails,
  frames,
  thumbnail,
  isOgVariant,
  boardStates,
  thumbnailWidth = THUMBNAIL_WIDTH,
  renderMode,
  glowFalloff,
  glyphs,
  veil,
  markStyle,
  holdGeometry,
}: BuildRenderConfigParams): RenderConfigResult {
  const ogScale = isOgVariant
    ? Math.min(
        (OG_IMAGE_WIDTH - OG_BOARD_PADDING_X * 2) / boardDetails.boardWidth,
        (OG_IMAGE_HEIGHT - OG_BOARD_PADDING_Y * 2) / boardDetails.boardHeight,
      )
    : null;

  const computeOutputWidth = () => {
    if (isOgVariant) return Math.max(1, Math.round(boardDetails.boardWidth * (ogScale || 1)));
    if (thumbnail) return thumbnailWidth;
    return boardDetails.boardWidth;
  };
  const outputWidth = computeOutputWidth();

  const isBoardsesh = renderMode === 'boardsesh';

  // Prefer each role's calibrated on-screen displayColor over its raw LED
  // color — the LED color is only correct for driving physical board
  // hardware over BLE (see light-control-drawer.tsx), not for what a viewer
  // sees on screen (issue #2202: raw LED blue renders far too dark against a
  // busy board photo). Boards without a displayColor (e.g. Kilter) render
  // unchanged.
  const holdStateMap: Record<number, { color: string; renderStyle?: string; role?: HoldRole }> = {};
  for (const [code, info] of Object.entries(boardStates)) {
    const role = isBoardsesh ? roleForHoldStateName(info.name) : undefined;
    holdStateMap[Number(code)] = {
      color: info.displayColor ?? info.color,
      ...(info.renderStyle ? { renderStyle: info.renderStyle } : {}),
      ...(role ? { role } : {}),
    };
  }

  // Lit holds get their silhouette geometry attached in boardsesh mode — plus
  // their mirroredHoldId partner, so the geometry is already in place for
  // whenever a mirrored render is requested (this builder always emits
  // `mirrored: false` today; see the comment below).
  const litHoldIds = isBoardsesh ? litHoldIdsFromFirstFrame(frames) : null;

  const holds: WasmRenderHold[] = boardDetails.holdsData.map((hold) => {
    const base: WasmRenderHold = {
      id: hold.id,
      mirroredHoldId: hold.mirroredHoldId,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
    };
    if (!litHoldIds) return base;
    // The LED cover goes on EVERY placement whose art paints the LED bright,
    // lit or not — an unlit hold's white pip is exactly what it hides.
    const led = holdGeometry?.ledBright?.[hold.id];
    const isLit = litHoldIds.has(hold.id) || (hold.mirroredHoldId !== null && litHoldIds.has(hold.mirroredHoldId));
    if (!isLit) return led ? { ...base, led } : base;

    const outline = holdGeometry?.outlines?.[hold.id];
    const silhouetteLightness = holdGeometry?.silhouetteLightness?.[hold.id];
    // The plate ring only means anything against the silhouette it was traced
    // inside, so it rides along with `outline` and never on its own.
    const ledInner = outline ? holdGeometry?.ledInner?.[hold.id] : undefined;
    return {
      ...base,
      ...(outline ? { outline } : {}),
      ...(ledInner ? { led_inner: ledInner } : {}),
      ...(led ? { led } : {}),
      ...(silhouetteLightness !== undefined ? { silhouette_lightness: silhouetteLightness } : {}),
    };
  });

  const hasLedBright = Object.keys(holdGeometry?.ledBright ?? {}).length > 0;

  const config: WasmRenderConfig = {
    board_name: boardName,
    board_width: boardDetails.boardWidth,
    board_height: boardDetails.boardHeight,
    output_width: outputWidth,
    frames,
    mirrored: false,
    // OG cards get the thumbnail stroke treatment (thicker rings, larger
    // markers) so holds stay readable at chat-preview sizes.
    thumbnail: thumbnail || isOgVariant,
    stroke_width_multiplier: getBoardStrokeWidthMultiplier(boardName as BoardName),
    // Matches mobile's DEFAULT_HOLD_SHAPE_SIZE (packages/mobile/src/lib/hold-color-overrides.ts) —
    // web/OG previously omitted this and silently rode the renderer's own
    // default, which happens to also be 1 today but drifted from mobile's
    // explicit knob (issue #2202).
    shape_size_multiplier: 1,
    holds,
    hold_state_map: holdStateMap,
    ...(isBoardsesh
      ? {
          render_mode: 'boardsesh' as const,
          glow_falloff: glowFalloff ?? 'soft',
          glyphs: glyphs ? ('role' as const) : ('off' as const),
          ...(veil ? { veil } : {}),
          ...(markStyle ? { mark_style: markStyle } : {}),
          ...(hasLedBright ? { led_cover: {} } : {}),
        }
      : {}),
  };

  return { config, outputWidth, ogScale };
}
