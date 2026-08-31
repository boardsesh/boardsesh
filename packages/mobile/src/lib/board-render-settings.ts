import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  BOARD_RENDER_SETTING_BOUNDS,
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  GLOW_FALLOFF_SETTINGS,
  HOLD_SHAPE_SETTINGS,
  MARK_STYLE_SETTINGS,
  THUMBNAIL_STYLE_SETTINGS,
  VEIL_SETTINGS,
  type BoardseshRenderSettings,
} from '@boardsesh/board-look';
import { getPreference, removePreference, setPreference } from './preference-store';
import { SCREENSHOT_RENDER_MODE } from './screenshot-mode';

/**
 * The look's tuning — every constant, every default and `resolveVeilOpacity` —
 * lives in `@boardsesh/board-look` so www, the OG cards and the backend draw
 * Aura with the same numbers this app does. Re-exported here because the mobile
 * codebase reaches for them through this module, and because this is where the
 * climber's stored preference turns into them.
 */
export type {
  BoardseshRenderSettings,
  GlowFalloffSetting,
  HoldShapeSetting,
  MarkStyleSetting,
  ThumbnailStyleSetting,
  VeilSetting,
} from '@boardsesh/board-look';
export {
  AURA_GLOW_TUNING,
  BOARD_FIELD_COLORS,
  BOARD_RENDER_SETTING_BOUNDS,
  BOARDSESH_SMALL_HOLD_MAX_BOOST,
  BOARDSESH_SMALL_HOLD_NO_BOOST,
  BOARDSESH_SOFT_DISC_OPACITY,
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  EDITING_MAX_VEIL_OPACITY,
  VEIL_SETTING_OPACITY,
  boardFieldColorForScheme,
  resolveVeilOpacity,
} from '@boardsesh/board-look';

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

export const BOARD_RENDER_MODE_OPTIONS = BOARD_RENDER_MODE_SETTINGS;
export const GLOW_FALLOFF_OPTIONS = GLOW_FALLOFF_SETTINGS;
export const VEIL_OPTIONS = VEIL_SETTINGS;
export const MARK_STYLE_OPTIONS = MARK_STYLE_SETTINGS;
export const THUMBNAIL_STYLE_OPTIONS = THUMBNAIL_STYLE_SETTINGS;
export const HOLD_SHAPE_OPTIONS = HOLD_SHAPE_SETTINGS;

export const DEFAULT_BOARD_RENDER_SETTINGS: BoardRenderSettings = {
  mode: 'default',
  boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS,
};

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
