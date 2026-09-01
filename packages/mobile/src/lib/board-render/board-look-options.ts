import {
  BOARD_RENDER_PRESETS,
  applyBoardRenderPreset,
  matchingPresetId,
  mergePresetPreservingAccessibility,
  type BoardRenderPresetId,
} from '../board-render-presets';
import {
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  setBoardRenderModePreference,
  type BoardRenderSettings,
} from '../board-render-settings';

/**
 * The board looks a climber picks between, as one list both surfaces render:
 * the one-time board-look step in onboarding, and the Board look settings
 * screen. Pure — no React, no storage — so the option order, the preview
 * bundles and the write path are all unit-testable without a renderer.
 *
 * "Classic" is an option here even though it is not a preset: `BOARD_RENDER_PRESETS`
 * only describes the Aura drawing's knobs, and the classic marker overlay
 * is a different drawing selected by `mode`. Folding both into one list is the
 * whole point — a climber choosing a look does not care which of the two
 * mechanisms expresses it.
 */

export type BoardLookOptionId = BoardRenderPresetId | 'classic' | 'custom';

export type BoardLookOption = {
  id: BoardLookOptionId;
  labelI18nKey: string;
  descriptionI18nKey: string;
  /**
   * The settings a preview card draws under, BEFORE the accessibility merge.
   *
   * `null` means "draw the climber's own live settings" — the configurable
   * Custom-card preview source. The settings screen passes the live variant, so
   * its Custom card mirrors what the climber has actually built; the onboarding
   * step has no custom settings to show yet, so it previews the Aura Bold
   * bundle under a question mark instead.
   */
  previewSettings: BoardRenderSettings | null;
  /** Draw the "?" plate over the preview (the onboarding Custom card). */
  placeholderOverlay: boolean;
  /**
   * The card is a lie unless the capability probe says `true` — an installed
   * library that predates the Aura drawing accepts its config, ignores
   * every field and hands back a classic render.
   */
  requiresBoardseshRenderer: boolean;
};

function presetValues(id: BoardRenderPresetId): BoardRenderSettings {
  const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown board render preset: ${id}`);
  return preset.values;
}

/**
 * Frozen classic bundle for the Classic card's preview.
 *
 * The `boardsesh` knob bundle is inert: `buildBoardRenderSignature` returns `''` for a
 * classic render, so this card's cache key is byte-identical to the one every
 * classic surface in the app already uses and the two share a single PNG.
 */
export const CLASSIC_PREVIEW_SETTINGS: BoardRenderSettings = Object.freeze({
  mode: 'classic',
  boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS,
});

const AURA_OPTION: BoardLookOption = {
  id: 'aura',
  labelI18nKey: 'mobile.more.boardLook.presets.aura',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.aura',
  previewSettings: presetValues('aura'),
  placeholderOverlay: false,
  requiresBoardseshRenderer: true,
};

const AURA_SUBTLE_OPTION: BoardLookOption = {
  id: 'aura-subtle',
  labelI18nKey: 'mobile.more.boardLook.presets.auraSubtle',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.auraSubtle',
  previewSettings: presetValues('aura-subtle'),
  placeholderOverlay: false,
  requiresBoardseshRenderer: true,
};

const MAX_CONTRAST_OPTION: BoardLookOption = {
  id: 'max-contrast',
  labelI18nKey: 'mobile.more.boardLook.presets.maxContrast',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.maxContrast',
  previewSettings: presetValues('max-contrast'),
  placeholderOverlay: false,
  requiresBoardseshRenderer: true,
};

const AURA_BOLD_OPTION: BoardLookOption = {
  id: 'aura-bold',
  labelI18nKey: 'mobile.more.boardLook.presets.auraBold',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.auraBold',
  previewSettings: presetValues('aura-bold'),
  placeholderOverlay: false,
  requiresBoardseshRenderer: true,
};

const CLASSIC_OPTION: BoardLookOption = {
  id: 'classic',
  labelI18nKey: 'mobile.more.boardLook.mode.options.classic',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.classic',
  previewSettings: CLASSIC_PREVIEW_SETTINGS,
  placeholderOverlay: false,
  requiresBoardseshRenderer: false,
};

/**
 * The onboarding step's Custom card: an Aura Bold render under a question mark.
 * There is nothing of the climber's own to show yet — the whole point of the
 * card is that they are about to go and build it.
 */
const CUSTOM_ONBOARDING_OPTION: BoardLookOption = {
  id: 'custom',
  labelI18nKey: 'mobile.more.boardLook.presets.custom',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.custom',
  previewSettings: presetValues('aura-bold'),
  placeholderOverlay: true,
  requiresBoardseshRenderer: true,
};

/** The settings screen's Custom card: a mirror of what the climber has built. */
const CUSTOM_SETTINGS_OPTION: BoardLookOption = {
  id: 'custom',
  labelI18nKey: 'mobile.more.boardLook.presets.custom',
  descriptionI18nKey: 'mobile.more.boardLook.presets.descriptions.custom',
  previewSettings: null,
  placeholderOverlay: false,
  requiresBoardseshRenderer: false,
};

/**
 * Product order: the new default first, then Classic.
 *
 * Classic sits second rather than after the Aura variants because it is the
 * drawing the climber already knows — the question this step asks is really
 * "the new look, or the one you had?", and burying the familiar answer behind
 * three unfamiliar ones misrepresents it as an afterthought. The remaining
 * Aura variants follow, and Custom is last.
 */
export const BOARD_LOOK_ONBOARDING_OPTIONS: readonly BoardLookOption[] = [
  AURA_OPTION,
  CLASSIC_OPTION,
  AURA_SUBTLE_OPTION,
  MAX_CONTRAST_OPTION,
  CUSTOM_ONBOARDING_OPTION,
];

/**
 * The settings screen shows Aura Bold too — there is room, and no decision to rush.
 * Same ordering as the step, so the two surfaces read the same way.
 */
export const BOARD_LOOK_SETTINGS_OPTIONS: readonly BoardLookOption[] = [
  AURA_OPTION,
  CLASSIC_OPTION,
  AURA_SUBTLE_OPTION,
  MAX_CONTRAST_OPTION,
  AURA_BOLD_OPTION,
  CUSTOM_SETTINGS_OPTION,
];

/**
 * Per-card preview settings, with every accessibility-owned field raised to the
 * climber's own value.
 *
 * Two reasons this is not just `option.previewSettings`. It keeps a climber's
 * role glyphs lit in every preview, and — because
 * `applyBoardLookOption` writes through the same merge — it makes the card an
 * honest promise: what it draws is what saving it produces.
 *
 * `undefined` for a value means "read the store", which is what
 * `useNativeClimbRender` does with an absent override.
 *
 * Callers MUST memoize this on `live`: the identities in the returned map feed
 * `renderSettingsOverride`, and a fresh object every render would re-fire every
 * card's overlay effect on every tick.
 */
export function buildBoardLookPreviewSettings(
  options: readonly BoardLookOption[],
  live: BoardRenderSettings,
): ReadonlyMap<BoardLookOptionId, BoardRenderSettings | undefined> {
  const previews = new Map<BoardLookOptionId, BoardRenderSettings | undefined>();
  for (const option of options) {
    previews.set(
      option.id,
      option.previewSettings ? mergePresetPreservingAccessibility(option.previewSettings, live) : undefined,
    );
  }
  return previews;
}

/**
 * Which card the climber's current settings sit on.
 *
 * Classic wins outright: every Aura preset also carries a full `boardsesh`
 * knob bundle, so a climber on the classic drawing would otherwise match
 * whichever preset their untouched knobs happened to equal.
 *
 * `'default'` is normalised to `'aura'` before matching. It means "the app
 * default", which since 2.4 IS the Aura drawing — so a climber who has
 * never chosen a mode sits on whichever preset their knobs equal (the plain
 * `aura` one, on a fresh install), not on `'custom'`. Without this the
 * board-look step would open with nothing selected for its entire audience.
 *
 * Delegates the preset comparison to `matchingPresetId` rather than repeating
 * it, so the accessibility relaxation cannot drift between the two.
 */
export function matchingBoardLookOptionId(settings: BoardRenderSettings): BoardLookOptionId {
  if (settings.mode === 'classic') return 'classic';
  return matchingPresetId(settings.mode === 'default' ? { ...settings, mode: 'aura' } : settings);
}

/**
 * Apply a card. The one write path both surfaces use, so the two can't drift.
 *
 * `'classic'` writes ONLY the mode: a climber who switches to the classic
 * drawing and back should find their Aura knobs where they left them.
 * `'custom'` lands them on the plain Aura bundle and the caller then opens
 * the Board look screen, so every slider they touch changes something visible.
 */
export async function applyBoardLookOption(id: BoardLookOptionId): Promise<void> {
  if (id === 'classic') {
    await setBoardRenderModePreference('classic');
    return;
  }
  await applyBoardRenderPreset(id === 'custom' ? 'aura' : id);
}
