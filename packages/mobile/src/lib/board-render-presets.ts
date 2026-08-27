import {
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
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
export type BoardRenderPresetId = 'boardsesh' | 'bold' | 'subtle' | 'max-contrast' | 'classic';

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
  {
    id: 'classic',
    labelI18nKey: 'mobile.more.boardLook.presets.classic',
    values: { mode: 'classic', boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS },
  },
] as const;

const BOARDSESH_SETTING_FIELDS = Object.keys(DEFAULT_BOARDSESH_RENDER_SETTINGS) as (keyof BoardseshRenderSettings)[];

function boardseshSettingsEqual(a: BoardseshRenderSettings, b: BoardseshRenderSettings): boolean {
  return BOARDSESH_SETTING_FIELDS.every((field) => a[field] === b[field]);
}

/** Apply a preset's bundle verbatim, overwriting every field it doesn't list a default for. */
export async function applyBoardRenderPreset(id: BoardRenderPresetId): Promise<void> {
  const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) return;
  await setBoardRenderSettingsPreference(preset.values);
}

/**
 * Which preset (if any) the climber's current settings already equal.
 *
 * Compares the whole bundle — `mode` and every `boardsesh` field — so a
 * settings object is a preset only when it matches one exactly; any hand
 * adjustment away from a preset reads as `'custom'` from the next render.
 */
export function matchingPresetId(settings: BoardRenderSettings): BoardRenderPresetId | 'custom' {
  for (const preset of BOARD_RENDER_PRESETS) {
    if (settings.mode === preset.values.mode && boardseshSettingsEqual(settings.boardsesh, preset.values.boardsesh)) {
      return preset.id;
    }
  }
  return 'custom';
}
