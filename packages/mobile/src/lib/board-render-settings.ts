import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { veilOpacityFor, type WallLightness } from '@boardsesh/board-art-geometry';
import { getPreference, removePreference, setPreference } from './preference-store';
import { SCREENSHOT_RENDER_MODE } from './screenshot-mode';

/**
 * Which board drawing the app renders, and every knob the Aura drawing
 * exposes (issue #2202).
 *
 * The classic drawing is the circle / marker-shape overlay that has always
 * shipped. The Aura drawing washes the unlit wall in the play field's own
 * colour and glows each lit hold's traced silhouette — it needs the shard data
 * in `@boardsesh/board-art-geometry` and a native library new enough to draw it,
 * so "which mode is this render in" is a three-way decision between the
 * climber, a rollout flag, and the binary in hand. `resolveEffectiveRenderSettings`
 * is that decision, in one place, and `buildBoardRenderSignature` is the string
 * that keeps a cached PNG from being reused under a setting that did not draw it.
 *
 * The store mirrors `hold-color-overrides.ts`: a module singleton read through
 * `useSyncExternalStore`, hydrated once from AsyncStorage, sanitised and clamped
 * on the way in and on every write — a preference file written by a newer build
 * (or hand-edited) can carry anything, and a NaN reach or an unknown mark style
 * would reach the Rust renderer as a config it silently falls back on.
 */

/**
 * What the climber picked. `default` means "the app default", which since 2.4
 * is Aura.
 *
 * `'aura'` is the wire value too: the Rust renderer, the native bridge and the
 * backend OG service were renamed with it, and every committed renderer
 * artifact was rebuilt in the same change. Nothing accepts `'boardsesh'` any
 * more — an artifact that predates the rename answers `Unknown` and falls back
 * to classic, which `native_artifact_contract.rs` now catches by requiring the
 * `core/src/aura/` module path in every committed binary.
 */
export type BoardRenderModeSetting = 'default' | 'classic' | 'aura';
/** The glow's alpha curve. `default` defers to the rollout flag, then to `soft`. */
export type GlowFalloffSetting = 'default' | 'soft' | 'plateau';
/**
 * How hard the field-colour veil washes the unlit wall. `auto` measures the
 * board's own art against the field (`veilOpacityFor`); the rest are fixed.
 */
export type VeilSetting = 'auto' | 'off' | 'soft' | 'strong' | 'custom';
/** What the Aura drawing puts on a lit hold at full size. */
export type MarkStyleSetting = 'glow' | 'glow-fill' | 'fill';
/**
 * The same choice for a list thumbnail, where a bare glow reads faint at
 * ~76px. `fill` renders as `glow-fill`, not a bare fill — the spike's
 * winning thumbnail arm was the filled mark WITH its own small glow
 * ("veil + tint"), so that pairing is what this maps to (see
 * `buildBoardseshFields` in `use-native-climb-render.ts`).
 */
export type ThumbnailStyleSetting = 'fill' | 'glow';
/**
 * What the Aura drawing lights on a hold: the traced silhouette from
 * `@boardsesh/board-art-geometry`, or the placement circle.
 *
 * `'circle'` is not a fallback — it is the Modern Classic look. The renderer
 * already draws the placement circle for any hold the tracer skipped
 * (`aura/geometry.rs`), so withholding the outlines is all it takes: the veil
 * punches circles out of the wash and the glow follows them, with no Rust
 * change and no new binary.
 */
export type HoldShapeSetting = 'silhouette' | 'circle';
export type BoardseshRenderSettings = {
  glowFalloff: GlowFalloffSetting;
  /** Overall glow reach multiplier. */
  glowReach: number;
  /** `plateau` falloff only: the share of the reach held at full alpha. */
  plateauShare: number;
  veil: VeilSetting;
  /** `custom` veil only: the wash's alpha. */
  veilOpacity: number;
  markStyle: MarkStyleSetting;
  /** `fill` / `glow-fill` only: alpha of the role-colour fill. */
  fillOpacity: number;
  /** The soft disc under the glow — the spike's rejected arm, kept as an A/B. */
  softDisc: boolean;
  /** Give a fingernail-sized foot chip a bigger glow instead of a second mark. */
  smallHoldBoost: boolean;
  /** Cover the LED pips the board art itself paints bright. */
  ledDots: boolean;
  /** Opt-in accessibility glyphs (FOOT ring, STARTING bar, HAND bar, FINISH X). */
  roleGlyphs: boolean;
  thumbnailStyle: ThumbnailStyleSetting;
  holdShape: HoldShapeSetting;
};

export type BoardRenderSettings = {
  mode: BoardRenderModeSetting;
  boardsesh: BoardseshRenderSettings;
};

/**
 * Where a `default` glow-falloff choice got its answer.
 *
 * There is no third source any more. Both board-render rollout flags
 * (`board-render-mode-default`, `board-glow-falloff`) were retired for 2.4: the
 * drawing and its falloff are the app's own defaults, and every knob is the
 * climber's to change under More > Board look.
 */
export type GlowFalloffSource = 'user' | 'default';

export type EffectiveBoardRenderSettings = {
  mode: 'classic' | 'aura';
  glowFalloff: 'soft' | 'plateau';
  glowFalloffSource: GlowFalloffSource;
  boardsesh: BoardseshRenderSettings;
  /** False forces `mode: 'classic'` — the binary cannot draw the other one. */
  rendererAvailable: boolean;
};

const BOARD_RENDER_MODE_SETTINGS = ['default', 'classic', 'aura'] as const;
const GLOW_FALLOFF_SETTINGS = ['default', 'soft', 'plateau'] as const;
const VEIL_SETTINGS = ['auto', 'off', 'soft', 'strong', 'custom'] as const;
const MARK_STYLE_SETTINGS = ['glow', 'glow-fill', 'fill'] as const;
const THUMBNAIL_STYLE_SETTINGS = ['fill', 'glow'] as const;
const HOLD_SHAPE_SETTINGS = ['silhouette', 'circle'] as const;

export const BOARD_RENDER_MODE_OPTIONS = BOARD_RENDER_MODE_SETTINGS;
export const GLOW_FALLOFF_OPTIONS = GLOW_FALLOFF_SETTINGS;
export const VEIL_OPTIONS = VEIL_SETTINGS;
export const MARK_STYLE_OPTIONS = MARK_STYLE_SETTINGS;
export const THUMBNAIL_STYLE_OPTIONS = THUMBNAIL_STYLE_SETTINGS;
export const HOLD_SHAPE_OPTIONS = HOLD_SHAPE_SETTINGS;

/** Slider ranges, exported so the settings screen and the clamps cannot drift. */
export const BOARD_RENDER_SETTING_BOUNDS = {
  glowReach: { min: 0.5, max: 2 },
  plateauShare: { min: 0.2, max: 0.7 },
  veilOpacity: { min: 0, max: 0.9 },
  fillOpacity: { min: 0.3, max: 0.9 },
} as const;

/**
 * The two fixed veil buckets, matching `VEIL_TUNING`'s soft and strong opacities
 * — a climber who overrides `auto` is choosing one of the same two washes the
 * measurement would have picked, not a third strength.
 */
export const VEIL_SETTING_OPACITY = { off: 0, soft: 0.3, strong: 0.6 } as const;

/** Peak alpha of the optional soft disc under the glow. */
export const BOARDSESH_SOFT_DISC_OPACITY = 0.3;
/** The renderer's own small-hold boost ceiling, and the value that turns it off. */
export const BOARDSESH_SMALL_HOLD_MAX_BOOST = 1.7;
export const BOARDSESH_SMALL_HOLD_NO_BOOST = 1;

/**
 * The Aura glow, as renderer tuning, spread into the config's `glow` object
 * (snake_case: the Rust `GlowTuning` fields).
 *
 * Unconditional at full size since the Glow-style knob was retired: `plain`
 * was the flat per-hold glow the drawing launched with, and it lost on every
 * board the glow lab measured, so keeping it as a setting only offered a worse
 * render under a name that collided with the look's own.
 * The owner's pick from PR #4972's three-way design review, tuned in the glow
 * lab against real climbs on five boards:
 *
 * - `spread_fraction` 0.91 is the reach-1.3 look shipped WITHOUT touching
 *   `reach_scale`, so the climber's Glow-reach slider keeps multiplying on
 *   top (pixel-identical to a reach_scale of 1.3 — verified RMSE 0).
 * - `merge_softness` fuses same-colour neighbours across their bisector (the
 *   dark V-notch the plain glow shows between adjacent holds).
 * - The seam pair replaces the hard colour switch between DIFFERENT-colour
 *   neighbours with a continuous, power-curved crossfade: `seam_sharpness` 3
 *   keeps the blend at a true 50/50 exactly on the bisector (a capped mix
 *   left a visible hard line there — the Grasshopper pie-slice bug) while
 *   collapsing to near-pure hold colour within a few pixels, so the
 *   ambiguous mid-mix (which can read as a THIRD role, worse under the CVD
 *   palettes) is confined to a thin sliver instead of an area.
 * - `fringe_deepen` keeps the falloff coloured to its edge instead of greying.
 * - No spill, no rim, no gamma, no white core: the review measured spill at
 *   this reach inventing lit-looking holds, and the stylised looks lost to
 *   the drawing's own character.
 *
 * Thumbnails skip the bundle (`buildBoardseshFields`): at 200px the
 * difference is invisible and the extra distance-field work is ~2.5× the
 * render. Every field left unnamed stays at its neutral Rust default; an old
 * binary would ignore these fields — safe only because they ship inside a
 * native-fingerprint bump (see the PR).
 */
// `seam_max_mix` is deliberately OMITTED: its Rust default (0.5) is
// load-bearing — the crossfade must reach a true 50/50 on the bisector for
// colour continuity; any lower cap re-creates the hard seam line.
export const AURA_GLOW_TUNING = {
  spread_fraction: 0.91,
  merge_softness: 0.6,
  seam_blend_fraction: 0.9,
  seam_sharpness: 3.0,
  fringe_deepen: 0.4,
} as const;

export const DEFAULT_BOARDSESH_RENDER_SETTINGS: BoardseshRenderSettings = {
  glowFalloff: 'default',
  glowReach: 1,
  plateauShare: 0.4,
  veil: 'auto',
  veilOpacity: 0.6,
  markStyle: 'glow',
  fillOpacity: 0.55,
  softDisc: false,
  smallHoldBoost: true,
  ledDots: true,
  roleGlyphs: false,
  thumbnailStyle: 'fill',
  holdShape: 'silhouette',
};

export const DEFAULT_BOARD_RENDER_SETTINGS: BoardRenderSettings = {
  mode: 'default',
  boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS,
};

/**
 * The play field the veil washes toward, per colour scheme — the theme's
 * `secondaryBackground` (`packages/mobile/src/theme/colors.ts`), restated as a
 * plain hex because that module resolves to an iOS `PlatformColor` the veil
 * cannot subtract a lightness from. Pinned by a test against the theme so the
 * two cannot drift.
 *
 * On the white light-mode field every board's wall is DARKER than the field, so
 * `veilOpacityFor` turns the veil off there without a special case.
 */
export const BOARD_FIELD_COLORS = { light: '#FFFFFF', dark: '#181225' } as const;

export function boardFieldColorForScheme(colorScheme: 'light' | 'dark'): string {
  return BOARD_FIELD_COLORS[colorScheme];
}

const STORAGE_KEY = 'boardRenderSettings';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickOption<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Clamp into range and round to two decimals.
 *
 * The rounding is not cosmetic: these numbers become signature tokens, and a
 * slider that hands back 1.2000000000000002 would mint a second cache key for a
 * render that is pixel-identical to the first.
 */
function clampSetting(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)) * 100) / 100;
}

export function sanitizeBoardseshRenderSettings(rawSettings: unknown): BoardseshRenderSettings {
  const stored = isRecord(rawSettings) ? rawSettings : {};
  const defaults = DEFAULT_BOARDSESH_RENDER_SETTINGS;
  return {
    glowFalloff: pickOption(stored.glowFalloff, GLOW_FALLOFF_SETTINGS, defaults.glowFalloff),
    glowReach: clampSetting(stored.glowReach, BOARD_RENDER_SETTING_BOUNDS.glowReach, defaults.glowReach),
    plateauShare: clampSetting(stored.plateauShare, BOARD_RENDER_SETTING_BOUNDS.plateauShare, defaults.plateauShare),
    veil: pickOption(stored.veil, VEIL_SETTINGS, defaults.veil),
    veilOpacity: clampSetting(stored.veilOpacity, BOARD_RENDER_SETTING_BOUNDS.veilOpacity, defaults.veilOpacity),
    markStyle: pickOption(stored.markStyle, MARK_STYLE_SETTINGS, defaults.markStyle),
    fillOpacity: clampSetting(stored.fillOpacity, BOARD_RENDER_SETTING_BOUNDS.fillOpacity, defaults.fillOpacity),
    softDisc: pickFlag(stored.softDisc, defaults.softDisc),
    smallHoldBoost: pickFlag(stored.smallHoldBoost, defaults.smallHoldBoost),
    ledDots: pickFlag(stored.ledDots, defaults.ledDots),
    roleGlyphs: pickFlag(stored.roleGlyphs, defaults.roleGlyphs),
    thumbnailStyle: pickOption(stored.thumbnailStyle, THUMBNAIL_STYLE_SETTINGS, defaults.thumbnailStyle),
    holdShape: pickOption(stored.holdShape, HOLD_SHAPE_SETTINGS, defaults.holdShape),
  };
}

/**
 * The mode value written by builds before 2.4 renamed the look to Aura.
 *
 * Read-only migration, and it has to exist: without it `pickOption` rejects the
 * unknown string and falls back to `'default'`, which `decideBoardLookStep`
 * reads as "never chose a look" and re-opens the one-time board-look step for
 * every climber who had already answered it.
 */
const LEGACY_BOARD_RENDER_MODE = 'boardsesh';

export function sanitizeBoardRenderSettings(rawSettings: unknown): BoardRenderSettings {
  const stored = isRecord(rawSettings) ? rawSettings : {};
  const storedMode = stored.mode === LEGACY_BOARD_RENDER_MODE ? 'aura' : stored.mode;
  return {
    mode: pickOption(storedMode, BOARD_RENDER_MODE_SETTINGS, DEFAULT_BOARD_RENDER_SETTINGS.mode),
    boardsesh: sanitizeBoardseshRenderSettings(stored.boardsesh),
  };
}

/**
 * What the climber asks for, before the binary gets a vote.
 *
 * `'default'` means "whatever the app draws by default", and since 2.4 that is
 * the Boardsesh drawing. It used to defer to the `board-render-mode-default`
 * rollout flag, which shipped at 0% and is now retired: the flip is the app's
 * default, and the one-time board-look step in onboarding is what asks the
 * climber whether they want something else.
 *
 * Split out of `resolveEffectiveRenderSettings` because the capability probe
 * costs two native renders per launch and is only worth paying for someone who
 * actually wants the mode — this answers that without allocating a settings
 * object on every virtualized row.
 */
export function requestedBoardRenderMode(settings: BoardRenderSettings): 'classic' | 'aura' {
  return settings.mode === 'default' ? 'aura' : settings.mode;
}

/**
 * Fold the climber's choices, the rollout flags and the installed renderer's
 * capability into the one settings object every render path reads.
 *
 * `rendererAvailable: false` forces classic. That is the whole safety property
 * of the probe: a library that predates the mode accepts a Boardsesh config,
 * ignores every field of it, and hands back a classic render — so the JS side
 * must never ask unless it has verified the library can answer.
 */
export function resolveEffectiveRenderSettings(
  settings: BoardRenderSettings,
  rendererAvailable: boolean,
): EffectiveBoardRenderSettings {
  const requestedMode = requestedBoardRenderMode(settings);
  const userFalloff = settings.boardsesh.glowFalloff;
  const glowFalloffSource: GlowFalloffSource = userFalloff !== 'default' ? 'user' : 'default';
  const glowFalloff = userFalloff !== 'default' ? userFalloff : 'soft';

  return {
    mode: rendererAvailable ? requestedMode : 'classic',
    glowFalloff,
    glowFalloffSource,
    boardsesh: settings.boardsesh,
    rendererAvailable,
  };
}

/**
 * How hard the veil washes this board, given the climber's choice and the
 * board's own measured wall.
 *
 * `auto` with no wall row is 0, not a guess: a board the tracer skipped (both
 * Woods sizes) has no reading to bucket, and washing an unmeasured wall is how
 * a field colour ends up brighter than the art it was meant to quiet.
 */
export function resolveVeilOpacity(
  settings: BoardseshRenderSettings,
  wallLightness: WallLightness | null,
  fieldColor: string,
): number {
  switch (settings.veil) {
    case 'off':
      return VEIL_SETTING_OPACITY.off;
    case 'soft':
      return VEIL_SETTING_OPACITY.soft;
    case 'strong':
      return VEIL_SETTING_OPACITY.strong;
    case 'custom':
      return settings.veilOpacity;
    case 'auto':
      return wallLightness
        ? veilOpacityFor({ wallLightness: wallLightness.mean, coverage: wallLightness.coverage, fieldColor })
        : 0;
  }
}

function formatSettingNumber(value: number): string {
  // The clamps already round to two decimals, so this never emits an exponent
  // or a float artefact — `1.2`, `0.55`, `2`.
  return String(value);
}

function formatVeilPercent(opacity: number): string {
  return String(Math.round(opacity * 100)).padStart(2, '0');
}

function formatFieldColor(fieldColor: string): string {
  return fieldColor.replace('#', '').toLowerCase();
}

/**
 * The cache-key fragment for one Boardsesh render, or `''` for classic.
 *
 * Every token that is absent means "at the shipped default", so a fresh install
 * mints the shortest key and a setting that has never been touched cannot split
 * the cache. The veil is the exception and is ALWAYS present: it is not a user
 * default but a measurement of this board against this theme's field, and it is
 * baked into the PNG — a light-mode overlay reused in dark mode would show a
 * wall the veil never quieted.
 *
 * Tokens whose value cannot reach the pixels (a plateau share under the `soft`
 * falloff, a fill opacity under a glow-only mark) still appear when they are off
 * their default. Cheap, and the alternative is a signature that has to model the
 * renderer's own relevance rules to stay honest.
 */
export function buildBoardRenderSignature(
  effective: EffectiveBoardRenderSettings,
  fieldColor: string,
  veilOpacity: number,
): string {
  if (effective.mode !== 'aura') return '';

  const { boardsesh } = effective;
  const defaults = DEFAULT_BOARDSESH_RENDER_SETTINGS;
  // Still the old spelling on purpose. This is a PNG cache key, not a name —
  // renaming it to match Aura would strand every cached render on every device
  // and buy a string nobody sees.
  const tokens: string[] = ['mode-boardsesh'];

  if (effective.glowFalloff !== 'soft') tokens.push(`glow-${effective.glowFalloff}`);
  if (boardsesh.glowReach !== defaults.glowReach) tokens.push(`reach-${formatSettingNumber(boardsesh.glowReach)}`);
  if (boardsesh.plateauShare !== defaults.plateauShare) {
    tokens.push(`plateau-${formatSettingNumber(boardsesh.plateauShare)}`);
  }
  tokens.push(veilOpacity > 0 ? `veil-${formatFieldColor(fieldColor)}-${formatVeilPercent(veilOpacity)}` : 'veil-off');
  if (boardsesh.markStyle !== defaults.markStyle) tokens.push(`marks-${boardsesh.markStyle}`);
  if (boardsesh.fillOpacity !== defaults.fillOpacity) tokens.push(`fill-${formatSettingNumber(boardsesh.fillOpacity)}`);
  if (boardsesh.softDisc) tokens.push('disc');
  if (!boardsesh.smallHoldBoost) tokens.push('noboost');
  if (!boardsesh.ledDots) tokens.push('noleds');
  if (boardsesh.roleGlyphs) tokens.push('glyphs');
  if (boardsesh.thumbnailStyle !== defaults.thumbnailStyle) tokens.push(`thumb-${boardsesh.thumbnailStyle}`);
  // Load-bearing: Modern Classic is Aura's every other knob, so without this
  // token the two looks share a cache entry and whichever rendered first is
  // what both draw.
  if (boardsesh.holdShape !== defaults.holdShape) tokens.push(`shape-${boardsesh.holdShape}`);

  return tokens.join('.');
}

type BoardRenderSettingsSnapshot = {
  settings: BoardRenderSettings;
  loaded: boolean;
};

let currentSettings: BoardRenderSettings = DEFAULT_BOARD_RENDER_SETTINGS;
let hasLoaded = false;
let snapshot: BoardRenderSettingsSnapshot = { settings: currentSettings, loaded: hasLoaded };
const listeners = new Set<() => void>();
const SERVER_SNAPSHOT: BoardRenderSettingsSnapshot = { settings: DEFAULT_BOARD_RENDER_SETTINGS, loaded: false };

function notify(): void {
  snapshot = { settings: currentSettings, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

/** Drop every non-default field, so an untouched install stores nothing at all. */
function compactBoardRenderSettings(settings: BoardRenderSettings): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  if (settings.mode !== DEFAULT_BOARD_RENDER_SETTINGS.mode) stored.mode = settings.mode;

  const boardseshDefaults: Record<string, unknown> = DEFAULT_BOARDSESH_RENDER_SETTINGS;
  const boardseshValues: Record<string, unknown> = settings.boardsesh;
  const boardsesh: Record<string, unknown> = {};
  for (const field of Object.keys(boardseshDefaults)) {
    if (boardseshValues[field] !== boardseshDefaults[field]) boardsesh[field] = boardseshValues[field];
  }
  if (Object.keys(boardsesh).length > 0) stored.boardsesh = boardsesh;
  return stored;
}

export async function loadBoardRenderSettings(): Promise<BoardRenderSettings> {
  if (hasLoaded) return currentSettings;
  // Screenshot builds pin the drawing instead of reading a preference, so a store
  // set can't come back in the wrong look because a default moved or a stale
  // preference file survived an install. `sanitizeBoardRenderSettings` still runs,
  // so an unusable EXPO_PUBLIC_SCREENSHOT_RENDER_MODE falls back to the app
  // default rather than reaching the Rust renderer as a config it ignores.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
    currentSettings = sanitizeBoardRenderSettings({ mode: SCREENSHOT_RENDER_MODE });
    hasLoaded = true;
    notify();
    return currentSettings;
  }
  const stored = await getPreference<unknown>(STORAGE_KEY);
  // A concurrent write landed while the read was in flight — it is newer than
  // whatever the disk held, so keep it.
  if (hasLoaded) return currentSettings;
  currentSettings = sanitizeBoardRenderSettings(stored);
  hasLoaded = true;
  notify();
  return currentSettings;
}

export async function setBoardRenderSettingsPreference(nextSettings: BoardRenderSettings): Promise<void> {
  currentSettings = sanitizeBoardRenderSettings(nextSettings);
  hasLoaded = true;
  notify();

  const stored = compactBoardRenderSettings(currentSettings);
  if (Object.keys(stored).length > 0) {
    await setPreference(STORAGE_KEY, stored);
  } else {
    await removePreference(STORAGE_KEY);
  }
}

export async function setBoardRenderModePreference(mode: BoardRenderModeSetting): Promise<void> {
  if (!hasLoaded) await loadBoardRenderSettings();
  await setBoardRenderSettingsPreference({ ...currentSettings, mode });
}

export async function setBoardseshRenderFieldPreference<Field extends keyof BoardseshRenderSettings>(
  field: Field,
  value: BoardseshRenderSettings[Field],
): Promise<void> {
  if (!hasLoaded) await loadBoardRenderSettings();
  await setBoardRenderSettingsPreference({
    ...currentSettings,
    boardsesh: { ...currentSettings.boardsesh, [field]: value },
  });
}

export async function resetBoardRenderSettings(): Promise<void> {
  await setBoardRenderSettingsPreference(DEFAULT_BOARD_RENDER_SETTINGS);
}

let loadPromise: Promise<BoardRenderSettings> | null = null;
function ensureBoardRenderSettingsLoaded(): Promise<BoardRenderSettings> {
  if (!loadPromise) {
    // Clear the promise on rejection so a read that failed before first unlock
    // is retried rather than caching the defaults forever (see preference-store).
    loadPromise = loadBoardRenderSettings().catch((error: unknown) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): BoardRenderSettingsSnapshot {
  return snapshot;
}

function getServerSnapshot(): BoardRenderSettingsSnapshot {
  return SERVER_SNAPSHOT;
}

/** Test-only handle: forget the hydrated settings so the next read re-loads them. */
export function _resetBoardRenderSettingsForTests(): void {
  currentSettings = DEFAULT_BOARD_RENDER_SETTINGS;
  hasLoaded = false;
  loadPromise = null;
  notify();
}

export function useBoardRenderSettings(): {
  settings: BoardRenderSettings;
  loaded: boolean;
  setMode: (mode: BoardRenderModeSetting) => void;
  setBoardseshField: <Field extends keyof BoardseshRenderSettings>(
    field: Field,
    value: BoardseshRenderSettings[Field],
  ) => void;
  reset: () => void;
} {
  const { settings, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    ensureBoardRenderSettingsLoaded().catch(() => {});
  }, []);

  const setMode = useCallback((mode: BoardRenderModeSetting) => {
    void setBoardRenderModePreference(mode);
  }, []);

  const setBoardseshField = useCallback(
    <Field extends keyof BoardseshRenderSettings>(field: Field, value: BoardseshRenderSettings[Field]) => {
      void setBoardseshRenderFieldPreference(field, value);
    },
    [],
  );

  const reset = useCallback(() => {
    void resetBoardRenderSettings();
  }, []);

  return { settings, loaded, setMode, setBoardseshField, reset };
}
