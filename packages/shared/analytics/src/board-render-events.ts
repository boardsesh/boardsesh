// Board render mode telemetry (issue #2202): the A/B between the classic
// marker overlay and the new "Boardsesh" glow drawing, plus the glow-falloff
// A/B (soft vs plateau) that only runs once a climber is on the Boardsesh
// drawing.
//
// The contract, one paragraph, mirrors gym-funnel.ts:
//
//  * Names live in `SHARED_EVENTS` (events.ts) — mobile fires every one of
//    these today, and nothing here is www-only the way the gym funnel is, so
//    they belong in the cross-platform catalog rather than a private one.
//  * Builders return `{ name, properties }` TOGETHER, so a caller cannot pair
//    one event's props with another event's name.
//  * Every property is `snake_case`, on purpose — it matches the super
//    properties `render_mode` / `glow_falloff` / `glow_falloff_source`
//    (registered via `registerRenderSuperProperties`, mirroring the existing
//    `connectivity` / `offline_engine_state` super properties), so a
//    dashboard built against the super property reads the per-event property
//    the same way.
//  * `buildBoardRenderTelemetryProps` is the ONE place the common props are
//    assembled — every builder below takes its output (plus its own extra
//    fields) as input, so no call site can drop `board_name` or hand-roll a
//    differently-cased duplicate.
//  * Stratify, never pool: `render_mode` and `glow_falloff_source` change the
//    population a metric is even measuring (only `boardsesh` climbers get a
//    glow-falloff answer at all), and boards differ enough in art and hold
//    density that pooling across `board_name` erases real per-board signal.
//    Full write-up: docs/board-render-analytics.md.
//
// Full contract, property tables and the PostHog dashboard setup steps:
// docs/board-render-analytics.md.

import type { AnalyticsEventProperties } from './create-analytics';
import { SHARED_EVENTS } from './events';

/**
 * Which drawing the render actually used, after settings + capability.
 *
 * `'boardsesh'` before 2.4 renamed the look to Aura — do not pool the two
 * spellings in a dashboard; see the value history in
 * `docs/board-render-analytics.md`.
 */
export type BoardRenderMode = 'classic' | 'aura';
/** The Aura drawing's glow alpha curve — the A/B this campaign runs. */
export type GlowFalloff = 'soft' | 'plateau';
/**
 * Where a `default` glow-falloff choice got its answer.
 *
 * No `'flag'` any more: both board-render rollout flags were retired for 2.4,
 * so the falloff is either the climber's own pick or the shipped default. Kept
 * as a property because it still separates two populations that must not be
 * pooled — someone who chose a curve is self-selected, someone on the default
 * is not.
 */
export type GlowFalloffSource = 'user' | 'default';
/** The two things a climber can do first after a climb view opens. */
export type ClimbActionType = 'queue' | 'ble';

/**
 * The settings half of the common props — a structural subset of mobile's
 * `EffectiveBoardRenderSettings` (`packages/mobile/src/lib/board-render-settings.ts`).
 * Declared locally rather than imported: a shared package must never depend on
 * `packages/mobile`, and passing the real (wider) mobile type in still works,
 * because TypeScript only requires it to structurally cover these three fields.
 */
export type BoardRenderEffectiveSettings = {
  mode: BoardRenderMode;
  glowFalloff: GlowFalloff;
  glowFalloffSource: GlowFalloffSource;
};

/** The board identity + optional preset/palette half of the common props. */
export type BoardRenderContext = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  /**
   * Set only once the settings-screen presets ship (a parallel PR, issue
   * #2202) — accepted here as an optional input so this module does not have
   * to wait on that PR, and left `undefined` until a call site has one.
   */
  presetId?: string;
  /** Same story as `presetId`, for the CVD palette presets. */
  paletteId?: string;
};

/**
 * Every board-render event's common props, in the exact shape every builder
 * below emits them. Built by `buildBoardRenderTelemetryProps` — never
 * hand-assembled at a call site.
 */
export type BoardRenderTelemetryProps = {
  board_name: string;
  layout_id: number;
  size_id: number;
  render_mode: BoardRenderMode;
  glow_falloff: GlowFalloff;
  glow_falloff_source: GlowFalloffSource;
  preset_id?: string;
  palette_id?: string;
};

/**
 * Assemble the common props every board-render event carries. `presetId` /
 * `paletteId` are omitted entirely (not sent as `undefined`) when absent, so
 * an event from before the presets PR ships looks identical to one from a
 * climber who simply isn't using a preset — both mean "no preset", and
 * `sanitizeForPosthog` would have stripped an explicit `undefined` anyway.
 */
export function buildBoardRenderTelemetryProps(
  effective: BoardRenderEffectiveSettings,
  context: BoardRenderContext,
): BoardRenderTelemetryProps {
  return {
    board_name: context.boardName,
    layout_id: context.layoutId,
    size_id: context.sizeId,
    render_mode: effective.mode,
    glow_falloff: effective.glowFalloff,
    glow_falloff_source: effective.glowFalloffSource,
    ...(context.presetId !== undefined ? { preset_id: context.presetId } : {}),
    ...(context.paletteId !== undefined ? { palette_id: context.paletteId } : {}),
  };
}

/**
 * A name paired with the exact properties that name expects. Builders return
 * this so a caller cannot hand one event's props to another event's name.
 * Constrained by `AnalyticsEventProperties` (not the narrower
 * `AnalyticsPropertyValue`) because `BoardRenderTelemetryProps.preset_id` /
 * `.palette_id` are optional — `track()` already expects exactly this shape.
 */
export type BoardRenderPayload<TName extends string, TProperties extends AnalyticsEventProperties> = {
  name: TName;
  properties: TProperties;
};

export type ClimbViewOpenedInput = BoardRenderTelemetryProps & {
  climb_uuid: string;
  /** Whether this climb was already viewed once this app run (a Set per app run). */
  reopened_in_session: boolean;
};

/**
 * `Climb View Opened` used to double as the glow-falloff experiment's exposure
 * event, carrying PostHog's two reserved `$feature_flag*` properties.
 *
 * That experiment is gone: `board-glow-falloff` was retired for 2.4 along with
 * `board-render-mode-default`, and the glow curve is now a plain user setting
 * under More > Board look rather than a randomised arm. The event keeps its own
 * properties and nothing else — `glow_falloff` and `glow_falloff_source` still
 * ship, so the two populations stay separable observationally, but there is no
 * randomisation left to attribute anything to.
 *
 * If an experiment is ever run here again, mint the exposure on this event
 * rather than turning `$feature_flag_called` back on: mobile reads every flag
 * with `sendEvent: false` (`READ_WITHOUT_EXPOSURE_EVENT` in
 * `packages/mobile/src/lib/analytics.ts`) because the provider re-reads the
 * whole catalog on every flags-changed tick, and leaving exposures on cost
 * ~173k events / 30 days — 13% of the project's volume.
 */
export function climbViewOpened(
  input: ClimbViewOpenedInput,
): BoardRenderPayload<typeof SHARED_EVENTS.ClimbViewOpened, ClimbViewOpenedInput> {
  return { name: SHARED_EVENTS.ClimbViewOpened, properties: input };
}

export type BoardPinchInput = BoardRenderTelemetryProps & {
  /** Peak absolute board scale reached during the gesture (not the raw pinch ratio). */
  scale_max: number;
  /** Lowest absolute board scale reached during the gesture. */
  scale_min: number;
  /**
   * SIGNED end-minus-start scale change: positive for a zoom in, negative for a
   * zoom out. `scale_max` alone cannot tell those apart — a gesture that only
   * zooms out never exceeds its own starting scale, so a max-minus-start delta
   * is exactly 0 for every zoom-out and the whole gesture reads as jitter.
   */
  scale_delta: number;
};

export function boardPinch(
  input: BoardPinchInput,
): BoardRenderPayload<typeof SHARED_EVENTS.BoardPinch, BoardPinchInput> {
  return { name: SHARED_EVENTS.BoardPinch, properties: input };
}

export type ClimbFirstActionInput = BoardRenderTelemetryProps & {
  climb_uuid: string;
  action_type: ClimbActionType;
  /** Milliseconds between the climb view opening and this first action. */
  ms_since_open: number;
};

export function climbFirstAction(
  input: ClimbFirstActionInput,
): BoardRenderPayload<typeof SHARED_EVENTS.ClimbFirstAction, ClimbFirstActionInput> {
  return { name: SHARED_EVENTS.ClimbFirstAction, properties: input };
}

export type BoardRenderSettingsChangedInput = BoardRenderTelemetryProps & {
  /** Which setting changed, e.g. `'mode'`, `'glowFalloff'`, `'glowReach'`. */
  field: string;
  /** The new value, stringified — settings are a closed set of strings/numbers/booleans. */
  value: string;
};

export function boardRenderSettingsChanged(
  input: BoardRenderSettingsChangedInput,
): BoardRenderPayload<typeof SHARED_EVENTS.BoardRenderSettingsChanged, BoardRenderSettingsChangedInput> {
  return { name: SHARED_EVENTS.BoardRenderSettingsChanged, properties: input };
}

/** Where a preset was applied from — the carousel now has two homes. */
export type BoardRenderPresetSurface = 'settings' | 'onboarding';

/**
 * A saved preset (render preset or CVD palette preset) was applied. Almost no
 * extra fields beyond the common props: applying a preset is exactly "the common
 * props now include a `preset_id` and/or `palette_id`", so the event is the
 * common props plus, optionally, which surface did it.
 *
 * `surface` is optional and additive: it arrived with the board-look carousel,
 * and an event without it is a settings-screen apply.
 */
export type BoardRenderPresetAppliedInput = BoardRenderTelemetryProps & { surface?: BoardRenderPresetSurface };

export function boardRenderPresetApplied(
  input: BoardRenderPresetAppliedInput,
): BoardRenderPayload<typeof SHARED_EVENTS.BoardRenderPresetApplied, BoardRenderPresetAppliedInput> {
  return { name: SHARED_EVENTS.BoardRenderPresetApplied, properties: input };
}

/** Which card the climber landed on in the board-look step. */
export type BoardLookOptionId =
  | 'aura'
  | 'aura-bold'
  | 'aura-subtle'
  | 'modern-classic'
  | 'max-contrast'
  | 'classic'
  | 'custom';

export type BoardLookStepShownInput = BoardRenderTelemetryProps & {
  /**
   * How many cards were offered. The step only appears once the capability
   * probe has said yes, so today this is the whole list; it is recorded rather
   * than assumed so that adding or gating a card later stays legible in the
   * funnel instead of silently shifting what a Shown means.
   */
  options_shown: number;
};

export function boardLookStepShown(
  input: BoardLookStepShownInput,
): BoardRenderPayload<typeof SHARED_EVENTS.BoardLookStepShown, BoardLookStepShownInput> {
  return { name: SHARED_EVENTS.BoardLookStepShown, properties: input };
}

export type BoardLookStepOutcome = 'saved' | 'customized' | 'skipped';

export type BoardLookStepResolvedInput = BoardRenderTelemetryProps & {
  outcome: BoardLookStepOutcome;
  /** The card under the finger at resolution; `null` when they skipped. */
  selected_option: BoardLookOptionId | null;
  /**
   * How many distinct cards the climber actually swiped to. The honest read on
   * whether the carousel was used or the default was accepted on sight — a
   * `saved` with one card viewed is not the same signal as one with five.
   */
  cards_viewed: number;
  /** Milliseconds between the step appearing and this resolution. */
  ms_to_resolve: number;
};

export function boardLookStepResolved(
  input: BoardLookStepResolvedInput,
): BoardRenderPayload<typeof SHARED_EVENTS.BoardLookStepResolved, BoardLookStepResolvedInput> {
  return { name: SHARED_EVENTS.BoardLookStepResolved, properties: input };
}

/**
 * Which surface the failed overlay belonged to. Mirrors the mobile hook's
 * `filledStyle` flag: the filled style is what the list / accessory thumbnails
 * ask for, the stroke-only style is the full-size play board.
 */
export type BoardRenderFailureSurface = 'full' | 'thumbnail';

/** Which half of the render path gave up. */
export type BoardRenderFailureStage = 'native' | 'image_load';

/**
 * Why the native renderer rejected.
 *
 * `capability_fallback` is a binary that predates a config's marker overrides or
 * the Aura drawing refusing them by design — the hook re-renders degraded, so
 * this is a "the climber saw the other drawing" signal rather than a defect.
 */
export type BoardRenderNativeFailureKind = 'render_failed' | 'disk_full' | 'capability_fallback';

/**
 * Why the generated PNG would not load. Mirrors the mobile hook's
 * `OverlayLoadTelemetryKind` one-for-one — the file was gone, the file was there
 * and still would not decode, validation threw, validation is unavailable
 * (the web twin), or the one retry the consumer gets was already spent.
 */
export type BoardRenderImageLoadFailureKind =
  | 'cache_entry_missing'
  | 'retry_exhausted'
  | 'cache_entry_present'
  | 'validation_failed'
  | 'validation_unsupported';

export type BoardRenderFailureKind = BoardRenderNativeFailureKind | BoardRenderImageLoadFailureKind;

/**
 * A low-cardinality bucket for the failure message.
 *
 * `code_<n>` is a numeric error code the native layer named. The rest are
 * coarse shapes of failure. Never the message itself — see
 * `classifyBoardRenderErrorCode`.
 */
export type BoardRenderErrorCode = `code_${number}` | 'png' | 'cgimage' | 'write' | 'module' | 'capability' | 'other';

/**
 * Anything that looks like a generated overlay filename. Stripped before the
 * buckets below are tried, for two reasons that point the same way:
 *
 *  * Privacy / cardinality: the cache key is in the filename, and nothing
 *    derived from it may reach an event property.
 *  * Correctness: every iOS write failure interpolates `"v5_<key>.png"` into
 *    its message, so a bare `/png/i` test would swallow the whole `write`
 *    bucket and label a full disk as a PNG-encoding fault.
 */
const OVERLAY_FILENAME_PATTERN = /\S*\.png/gi;

/** A numeric code the native layer named, e.g. `Rust render failed with code -2`. */
const NATIVE_ERROR_CODE_PATTERN = /code (-?\d+)/i;

/**
 * Bucket a render failure message into something a dashboard can group on.
 *
 * The raw message is never safe to send: it interpolates the cache key, the
 * cache path and, on iOS, translated OS prose. This returns one of a closed set
 * of strings instead, so `Board Render Failed` stays groupable and carries no
 * identifier.
 *
 * A named numeric code wins over every prose match — it is the most specific
 * thing the native layer ever tells us, and it survives translation.
 */
export function classifyBoardRenderErrorCode(message: string): BoardRenderErrorCode {
  const codeMatch = NATIVE_ERROR_CODE_PATTERN.exec(message);
  if (codeMatch) {
    const code = Number.parseInt(codeMatch[1], 10);
    if (Number.isFinite(code)) return `code_${code}`;
  }
  const prose = message.replace(OVERLAY_FILENAME_PATTERN, '');
  if (/png/i.test(prose)) return 'png';
  if (/CGImage/i.test(prose)) return 'cgimage';
  if (/write|save|volume|space|ENOSPC/i.test(prose)) return 'write';
  if (/not available|no usable render/i.test(prose)) return 'module';
  if (/rebuilt BoardRenderer native binary/.test(prose)) return 'capability';
  return 'other';
}

/** The fields every `Board Render Failed` carries on top of the common props. */
export type BoardRenderFailureFields = {
  surface: BoardRenderFailureSurface;
  error_code: BoardRenderErrorCode;
  /** The requested overlay width in pixels; `null` for a native-width render. */
  render_width: number | null;
  /** Length of the frames string — a cheap proxy for climb complexity. */
  frames_length: number;
  /**
   * How many render failures this JS lifetime has seen, INCLUDING this one.
   * Keeps counting past the 25-event cap, so a stream that stops at 25 is still
   * legible as truncated rather than as a device that failed 25 times.
   */
  failures_this_session: number;
};

/**
 * `stage` and `failure_kind` are one discriminated pair, not two free fields: a
 * native rejection can never be `retry_exhausted` and an image load can never be
 * `disk_full`, and pairing them in the type is what stops a call site inventing
 * a combination no dashboard query would ever match.
 */
export type BoardRenderFailedInput = BoardRenderTelemetryProps &
  BoardRenderFailureFields &
  (
    | { stage: 'native'; failure_kind: BoardRenderNativeFailureKind }
    | { stage: 'image_load'; failure_kind: BoardRenderImageLoadFailureKind }
  );

export function boardRenderFailed(
  input: BoardRenderFailedInput,
): BoardRenderPayload<typeof SHARED_EVENTS.BoardRenderFailed, BoardRenderFailedInput> {
  return { name: SHARED_EVENTS.BoardRenderFailed, properties: input };
}
