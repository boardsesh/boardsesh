import {
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  loadBoardRenderSettings,
  setBoardRenderSettingsPreference,
  type BoardRenderSettings,
  type BoardseshRenderSettings,
} from './board-render-settings';

/**
 * Named bundles of the Aura render knobs (issue #2202), so a climber can
 * pick a look in one tap instead of hand-tuning eleven fields.
 *
 * Every preset's `values` is a COMPLETE `BoardRenderSettings` applied verbatim
 * through `setBoardRenderSettingsPreference` — the same write path `reset()`
 * uses — so applying one always lands on an exact, reproducible bundle rather
 * than layering on top of whatever the climber had before.
 */
export type BoardRenderPresetId = 'aura' | 'aura-bold' | 'aura-subtle' | 'max-contrast';

export type BoardRenderPreset = {
  id: BoardRenderPresetId;
  labelI18nKey: string;
  values: BoardRenderSettings;
};

function boardseshPreset(overrides: Partial<BoardseshRenderSettings>): BoardseshRenderSettings {
  return { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...overrides };
}

/**
 * The tuning each preset differs by, named rather than inlined.
 *
 * These are the numbers a design pass actually argues about, so they are stated
 * once, next to each other, where the difference between two presets is legible
 * — `BOLD.glowReach` against `SUBTLE.glowReach` rather than a 1.3 and a 0.8
 * buried in separate object literals. Anything a preset does not name here is
 * inherited from `DEFAULT_BOARDSESH_RENDER_SETTINGS`.
 */
export const BOARD_RENDER_PRESET_VALUES = {
  /** The shipped look: a soft glow on the traced silhouette, veil measured per board. */
  aura: DEFAULT_BOARDSESH_RENDER_SETTINGS,
  /** Wider, harder glow with a filled mark — reads from across the room. */
  'aura-bold': {
    glowFalloff: 'plateau',
    glowReach: 1.3,
    veil: 'strong',
    markStyle: 'glow-fill',
  },
  /** Tighter glow, gentler wash — closest to an unlit board. */
  'aura-subtle': {
    glowFalloff: 'soft',
    glowReach: 0.8,
    veil: 'soft',
  },
  /** Strongest separation: full wash, solid marks, plus the non-colour glyphs. */
  'max-contrast': {
    glowFalloff: 'plateau',
    veil: 'custom',
    veilOpacity: 0.7,
    markStyle: 'fill',
    fillOpacity: 0.85,
    roleGlyphs: true,
  },
} as const satisfies Record<BoardRenderPresetId, Partial<BoardseshRenderSettings>>;

export const BOARD_RENDER_PRESETS: readonly BoardRenderPreset[] = [
  {
    id: 'aura',
    labelI18nKey: 'mobile.more.boardLook.presets.aura',
    values: { mode: 'aura', boardsesh: boardseshPreset(BOARD_RENDER_PRESET_VALUES.aura) },
  },
  {
    id: 'aura-bold',
    labelI18nKey: 'mobile.more.boardLook.presets.auraBold',
    values: { mode: 'aura', boardsesh: boardseshPreset(BOARD_RENDER_PRESET_VALUES['aura-bold']) },
  },
  {
    id: 'aura-subtle',
    labelI18nKey: 'mobile.more.boardLook.presets.auraSubtle',
    values: { mode: 'aura', boardsesh: boardseshPreset(BOARD_RENDER_PRESET_VALUES['aura-subtle']) },
  },
  {
    id: 'max-contrast',
    labelI18nKey: 'mobile.more.boardLook.presets.maxContrast',
    values: { mode: 'aura', boardsesh: boardseshPreset(BOARD_RENDER_PRESET_VALUES['max-contrast']) },
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
 * A climber who turned Role glyphs on did it because colour alone was not
 * enough for them — the glyphs are the only non-colour channel they have. A
 * preset writes its whole bundle verbatim, so without this list picking
 * "Aura Subtle" would quietly switch them back off and hand a colour-blind climber a
 * colour-only board.
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
 * produces, including for the climber whose role glyphs it preserves.
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
 * exactly, or a climber with role glyphs on who taps "Aura Subtle" would read back as
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
