import {
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  loadBoardRenderSettings,
  setBoardRenderSettingsPreference,
  type BoardRenderSettings,
  type BoardseshRenderSettings,
} from './board-render-settings';

/**
 * Named bundles of the Boardsesh render knobs (issue #2202), so a climber can
 * pick a look in one tap instead of hand-tuning eleven fields.
 *
 * Every preset's `values` is a COMPLETE `BoardRenderSettings` applied verbatim
 * through `setBoardRenderSettingsPreference` — the same write path `reset()`
 * uses — so applying one always lands on an exact, reproducible bundle rather
 * than layering on top of whatever the climber had before.
 */
export type BoardRenderPresetId = 'boardsesh' | 'bold' | 'subtle' | 'max-contrast';

export type BoardRenderPreset = {
  id: BoardRenderPresetId;
  labelI18nKey: string;
  values: BoardRenderSettings;
};

function boardseshPreset(overrides: Partial<BoardseshRenderSettings>): BoardseshRenderSettings {
  return { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...overrides };
}

export const BOARD_RENDER_PRESETS: readonly BoardRenderPreset[] = [
  {
    id: 'boardsesh',
    labelI18nKey: 'mobile.more.boardLook.presets.boardsesh',
    values: { mode: 'boardsesh', boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS },
  },
  {
    id: 'bold',
    labelI18nKey: 'mobile.more.boardLook.presets.bold',
    values: {
      mode: 'boardsesh',
      boardsesh: boardseshPreset({ glowFalloff: 'plateau', glowReach: 1.3, veil: 'strong', markStyle: 'glow-fill' }),
    },
  },
  {
    id: 'subtle',
    labelI18nKey: 'mobile.more.boardLook.presets.subtle',
    values: {
      mode: 'boardsesh',
      boardsesh: boardseshPreset({ glowFalloff: 'soft', glowReach: 0.8, veil: 'soft' }),
    },
  },
  {
    id: 'max-contrast',
    labelI18nKey: 'mobile.more.boardLook.presets.maxContrast',
    values: {
      mode: 'boardsesh',
      boardsesh: boardseshPreset({
        glowFalloff: 'plateau',
        veil: 'custom',
        veilOpacity: 0.7,
        markStyle: 'fill',
        fillOpacity: 0.85,
        roleGlyphs: true,
      }),
    },
  },
] as const;

const BOARDSESH_SETTING_FIELDS = Object.keys(DEFAULT_BOARDSESH_RENDER_SETTINGS) as (keyof BoardseshRenderSettings)[];

/** The `BoardseshRenderSettings` keys whose value is a plain boolean. */
type BooleanBoardseshField = {
  [Field in keyof BoardseshRenderSettings]: BoardseshRenderSettings[Field] extends boolean ? Field : never;
}[keyof BoardseshRenderSettings];

/**
 * Fields the ACCESSIBILITY surface owns rather than the preset.
 *
 * `applyCvdPalette('monochrome', ...)` turns `roleGlyphs` on because a
 * colour-only cue is meaningless once every role reads as a shade of grey — the
 * glyphs are the only non-colour channel that climber has. A preset writes its
 * whole bundle verbatim, so without this list picking "Subtle" would quietly
 * switch them back off and hand a colour-blind climber a colour-only board.
 *
 * The rule is one-directional: a preset may turn one of these ON (`max-contrast`
 * ships `roleGlyphs: true` deliberately) but never OFF, so applying a preset can
 * only ever raise the accessibility floor. That is why every entry has to be a
 * boolean whose `true` is the stronger affordance — the merge below is an OR and
 * the match below reads `true` as "at least the preset". `BooleanBoardseshField`
 * makes adding a non-boolean here a compile error rather than a silent
 * misbehaviour.
 */
export const ACCESSIBILITY_OWNED_BOARDSESH_FIELDS = ['roleGlyphs'] as const satisfies readonly BooleanBoardseshField[];

function isAccessibilityOwned(field: keyof BoardseshRenderSettings): field is BooleanBoardseshField {
  return (ACCESSIBILITY_OWNED_BOARDSESH_FIELDS as readonly string[]).includes(field);
}

/**
 * A preset's bundle with every accessibility-owned field raised to the climber's
 * current value.
 *
 * Pure, and exported, so the write path below and the carousel's preview cards
 * apply the identical rule — what a preview card draws is exactly what saving it
 * produces, including for the monochrome climber whose glyphs it preserves.
 */
export function mergePresetPreservingAccessibility(
  presetValues: BoardRenderSettings,
  current: BoardRenderSettings,
): BoardRenderSettings {
  const boardsesh: BoardseshRenderSettings = { ...presetValues.boardsesh };
  for (const field of ACCESSIBILITY_OWNED_BOARDSESH_FIELDS) {
    boardsesh[field] = presetValues.boardsesh[field] || current.boardsesh[field];
  }
  return { mode: presetValues.mode, boardsesh };
}

/**
 * Whether the climber's settings sit on this preset.
 *
 * An accessibility-owned field matches when it equals the preset's value OR is
 * `true` — the relaxation has to mirror `mergePresetPreservingAccessibility`
 * exactly, or a monochrome climber who taps "Subtle" would read back as
 * `'custom'` from the very next render and no card would highlight.
 *
 * It forgives the field however it came to be `true`, not just via a CVD
 * palette — a climber who flips Role glyphs on by hand still reads as the
 * preset they are otherwise on. That is deliberate: re-applying that preset is
 * a no-op under the same OR merge, so the two stay consistent. It cannot make
 * two presets match at once; every pair differs on at least one field the
 * preset itself owns.
 */
function boardseshSettingsMatchPreset(current: BoardseshRenderSettings, preset: BoardseshRenderSettings): boolean {
  return BOARDSESH_SETTING_FIELDS.every((field) =>
    isAccessibilityOwned(field)
      ? current[field] === preset[field] || current[field] === true
      : current[field] === preset[field],
  );
}

/**
 * Apply a preset's bundle, overwriting every field it doesn't list a default for
 * — except the accessibility-owned ones, which are only ever raised.
 */
export async function applyBoardRenderPreset(id: BoardRenderPresetId): Promise<void> {
  const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) return;
  // Hydrates on first call and returns the live singleton after — the same read
  // `setBoardRenderModePreference` already does before a partial write.
  const current = await loadBoardRenderSettings();
  await setBoardRenderSettingsPreference(mergePresetPreservingAccessibility(preset.values, current));
}

/**
 * Which preset (if any) the climber's current settings already equal.
 *
 * Compares the whole bundle — `mode` and every `boardsesh` field — so a settings
 * object is a preset only when it matches one exactly; any hand adjustment away
 * from a preset reads as `'custom'` from the next render. The one exception is
 * an accessibility-owned field the climber has raised above the preset's value,
 * which `boardseshSettingsMatchPreset` forgives.
 */
export function matchingPresetId(settings: BoardRenderSettings): BoardRenderPresetId | 'custom' {
  for (const preset of BOARD_RENDER_PRESETS) {
    if (
      settings.mode === preset.values.mode &&
      boardseshSettingsMatchPreset(settings.boardsesh, preset.values.boardsesh)
    ) {
      return preset.id;
    }
  }
  return 'custom';
}
