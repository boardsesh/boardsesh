import {
  HOLD_COLOR_OVERRIDE_ROLES,
  normalizeHexColor,
  type HoldColorOverrideRole,
  type HoldColorOverrides,
} from './hold-color-overrides';
import type { BoardseshRenderSettings } from './board-render-settings';
import type { CvdType } from './cvd-simulation';

/**
 * One-tap colour-vision palettes for the four hold roles (issue #2202).
 *
 * Applying one writes the four role colour overrides through
 * `useHoldColorOverrides().setRoleOverride` — the same store a manual colour
 * pick writes to — so it reaches the physical board's LEDs exactly like setting
 * each colour by hand. The settings screen says so in the UI copy
 * (`mobile.more.boardLook.accessibility.cvdPalette.note`); this module doesn't
 * touch Bluetooth at all.
 *
 * Every palette below is validated (not just eyeballed) against
 * `color-contrast-oracle.ts` in `__tests__/cvd-palette-presets.test.ts`: every
 * role clears 3:1 WCAG contrast against the dark play field, and every pair of
 * roles clears 8 CIEDE2000 units apart under the CVD matrix the palette targets
 * (plain sRGB for `monochrome`, which has no CVD matrix of its own — it is a
 * lightness ramp, built to stay distinguishable by lightness alone under total
 * colour blindness). The same test pins that the boards' SHIPPED default
 * palette does not clear that bar — Grasshopper's HAND/FOOT pair is 3.8 ΔE00
 * apart under Machado protan, well under 8 — which is the reason these presets
 * exist.
 *
 * `protanopia` and `deuteranopia` share one quad (Wong / Okabe-Ito 2011's
 * colour-blind-safe eight, the four most different values from it): it clears
 * both the protan and deutan matrices, so there's no reason to make a climber
 * pick between the two dichromacies deliberately. `tritanopia` uses the
 * peer-reviewed Machado tritan matrix, not the "simple" one — see
 * `color-contrast-oracle.ts`'s header for why the simple tritan matrix isn't
 * trustworthy enough to design a palette against.
 */
export type CvdPaletteId = 'protanopia' | 'deuteranopia' | 'tritanopia' | 'monochrome';

export type CvdPaletteRoleColors = Record<HoldColorOverrideRole, string>;

export type CvdPalettePreset = {
  id: CvdPaletteId;
  labelI18nKey: string;
  /** The dichromacy this palette targets, or `null` for `monochrome` (a
   *  lightness ramp with no CVD matrix of its own). */
  cvdType: CvdType | null;
  roles: CvdPaletteRoleColors;
};

export const CVD_PALETTE_PRESETS: readonly CvdPalettePreset[] = [
  {
    id: 'protanopia',
    labelI18nKey: 'mobile.more.boardLook.accessibility.cvdPalette.presets.protanopia',
    cvdType: 'protanopia',
    roles: { STARTING: '#0072b2', HAND: '#e69f00', FINISH: '#cc79a7', FOOT: '#f0e442' },
  },
  {
    id: 'deuteranopia',
    labelI18nKey: 'mobile.more.boardLook.accessibility.cvdPalette.presets.deuteranopia',
    cvdType: 'deuteranopia',
    roles: { STARTING: '#0072b2', HAND: '#e69f00', FINISH: '#cc79a7', FOOT: '#f0e442' },
  },
  {
    id: 'tritanopia',
    labelI18nKey: 'mobile.more.boardLook.accessibility.cvdPalette.presets.tritanopia',
    cvdType: 'tritanopia',
    roles: { STARTING: '#0e9e77', HAND: '#d95f02', FINISH: '#ca2270', FOOT: '#9acd32' },
  },
  {
    id: 'monochrome',
    labelI18nKey: 'mobile.more.boardLook.accessibility.cvdPalette.presets.monochrome',
    cvdType: null,
    roles: { STARTING: '#f2f2f2', HAND: '#c0c0c0', FINISH: '#909090', FOOT: '#707070' },
  },
] as const;

function findPreset(id: CvdPaletteId): CvdPalettePreset | undefined {
  return CVD_PALETTE_PRESETS.find((preset) => preset.id === id);
}

/** The live hook shapes this needs — matches `useHoldColorOverrides()` and `useBoardRenderSettings()`. */
export type CvdPaletteActions = {
  setRoleOverride: (role: HoldColorOverrideRole, color: string | null) => void;
  setBoardseshField: <Field extends keyof BoardseshRenderSettings>(
    field: Field,
    value: BoardseshRenderSettings[Field],
  ) => void;
};

/**
 * Apply a palette verbatim: one `setRoleOverride` per hold role, writing through
 * the same store (and the same LED-reaching path) a manual colour pick does.
 *
 * `monochrome` also turns on `roleGlyphs` — a colour-only cue is meaningless
 * once every role reads as a shade of grey, so the shape-based accessibility
 * channel has to come with it.
 */
export function applyCvdPalette(id: CvdPaletteId, actions: CvdPaletteActions): void {
  const preset = findPreset(id);
  if (!preset) return;
  for (const role of HOLD_COLOR_OVERRIDE_ROLES) {
    actions.setRoleOverride(role, preset.roles[role]);
  }
  if (id === 'monochrome') actions.setBoardseshField('roleGlyphs', true);
}

/**
 * Which palette (if any) the climber's current colour overrides already match.
 *
 * Matches only when every one of the four roles is explicitly overridden to the
 * palette's exact hex — a climber who has only touched one role never
 * "accidentally" reads as a palette, and a colour left at the board's default
 * (no override) never counts as a match either.
 */
export function matchingCvdPaletteId(colors: HoldColorOverrides): CvdPaletteId | 'custom' {
  for (const preset of CVD_PALETTE_PRESETS) {
    const matchesEveryRole = HOLD_COLOR_OVERRIDE_ROLES.every(
      (role) => normalizeHexColor(colors[role]) === preset.roles[role],
    );
    if (matchesEveryRole) return preset.id;
  }
  return 'custom';
}
