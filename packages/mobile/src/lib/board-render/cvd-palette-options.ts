import {
  CVD_PALETTE_PRESETS,
  applyCvdPalette,
  type CvdPaletteActions,
  type CvdPaletteId,
} from '../cvd-palette-presets';
import { HOLD_COLOR_OVERRIDE_ROLES, type HoldColorOverrides } from '../hold-color-overrides';

/**
 * The five cards on the colour-vision rail, as data: the climber's own board
 * drawn under the palette each card would apply.
 *
 * A picker, not a viewer. The rail this replaces showed the same board through
 * three dichromacy simulations, which is a tool for a sighted person auditing
 * their setup — a colour-blind climber does not need a picture of colour
 * blindness, they need palettes that stay apart and a way to put one on. So each
 * card here previews a palette and pressing it applies it.
 *
 * Pure — no React, no storage — so the option list, its labels and the colours
 * behind it are unit-testable without a renderer.
 *
 * The three palette NAMES come from `cvd-palette-presets`' own label keys rather
 * than a second copy under this namespace: the verdict line names the same three
 * dichromacies, and two sets of translations for "Protanopia" would drift.
 */
export type CvdPaletteOptionId = CvdPaletteId | 'default' | 'custom';

export type CvdPaletteOption = {
  id: CvdPaletteOptionId;
  /**
   * The `…I18nKey` suffix is load-bearing, not decoration: `check:i18n:orphans`
   * treats a property with that name as a key holder, so it records these
   * literals AND accepts the card's `t(option.labelI18nKey)` as statically
   * resolved instead of hard-failing it as an unanalyzable `t()` argument.
   */
  labelI18nKey: string;
  descriptionI18nKey: string;
  /**
   * The role colours this card DRAWS with, which is not the same thing as the
   * colours it would write.
   *
   * A full map for each palette. `{}` — an empty map, not `undefined` — for
   * `default`: an empty override set is what "the colours Boardsesh ships with"
   * means to the renderer, and it makes that card share the PNG every untouched
   * board in the app already rendered. `undefined` for `custom`, which means
   * "read the store", so it mirrors whatever the climber has actually got.
   */
  previewRoles: HoldColorOverrides | undefined;
};

/** Frozen so a card's preview map is referentially stable across every render. */
const NO_OVERRIDES: HoldColorOverrides = Object.freeze({});

function presetFor(id: CvdPaletteId) {
  const preset = CVD_PALETTE_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown colour-vision palette: ${id}`);
  return preset;
}

/** The palette's four colours as an override map, frozen for referential stability. */
function previewRolesFor(id: CvdPaletteId): HoldColorOverrides {
  const preset = presetFor(id);
  const previewRoles: HoldColorOverrides = {};
  for (const role of HOLD_COLOR_OVERRIDE_ROLES) previewRoles[role] = preset.roles[role];
  return Object.freeze(previewRoles);
}

/**
 * Default first — it is where an untouched install sits, and a rail whose
 * active card is off screen at rest tells the climber nothing. Then protanopia
 * and deuteranopia (which share one quad), then tritanopia, which is the rarest
 * dichromacy. Custom is last, the way it is on the board-look rail.
 *
 * No greyscale card: these palettes exist to keep the four roles APART, and
 * dropping the colour channel removes the one thing doing that — it leans wholly
 * on role glyphs, which is a switch of its own further down the same screen.
 */
export const CVD_PALETTE_OPTIONS: readonly CvdPaletteOption[] = Object.freeze([
  {
    id: 'default',
    labelI18nKey: 'mobile.more.accessibility.palettes.cards.default.title',
    descriptionI18nKey: 'mobile.more.accessibility.palettes.cards.default.subtitle',
    previewRoles: NO_OVERRIDES,
  },
  // Every key is spelled out as a property literal, never interpolated from the
  // id: `check:i18n:orphans` reads `*I18nKey` PROPERTIES statically, and a key it
  // cannot see reads as orphaned copy and gets deleted from all four locales.
  {
    id: 'protanopia',
    labelI18nKey: presetFor('protanopia').labelI18nKey,
    descriptionI18nKey: 'mobile.more.accessibility.palettes.cards.protanopia.subtitle',
    previewRoles: previewRolesFor('protanopia'),
  },
  {
    id: 'deuteranopia',
    labelI18nKey: presetFor('deuteranopia').labelI18nKey,
    descriptionI18nKey: 'mobile.more.accessibility.palettes.cards.deuteranopia.subtitle',
    previewRoles: previewRolesFor('deuteranopia'),
  },
  {
    id: 'tritanopia',
    labelI18nKey: presetFor('tritanopia').labelI18nKey,
    descriptionI18nKey: 'mobile.more.accessibility.palettes.cards.tritanopia.subtitle',
    previewRoles: previewRolesFor('tritanopia'),
  },
  {
    id: 'custom',
    labelI18nKey: 'mobile.more.accessibility.palettes.cards.custom.title',
    descriptionI18nKey: 'mobile.more.accessibility.palettes.cards.custom.subtitle',
    previewRoles: undefined,
  },
]);

/**
 * Which card the climber's current colours sit on.
 *
 * `matchingCvdPaletteId` answers "a palette, or something else"; the something
 * else splits two ways here. No role overridden at all is not a custom palette,
 * it is the board's own — the `default` card — and calling it Custom would leave
 * a fresh install with its Custom card lit and nothing explaining why.
 *
 * Takes the match as a parameter rather than computing it, so the caller keeps
 * one source of truth for it (the verdict and the rail must agree) and this
 * stays a pure two-line decision.
 */
export function selectedCvdPaletteCardId(
  matchedPaletteId: CvdPaletteId | 'custom',
  overrides: HoldColorOverrides,
): CvdPaletteOptionId {
  if (matchedPaletteId !== 'custom') return matchedPaletteId;
  const hasAnyRoleColor = HOLD_COLOR_OVERRIDE_ROLES.some((role) => overrides[role] !== undefined);
  return hasAnyRoleColor ? 'custom' : 'default';
}

/** The live hooks this needs, injected so the write path stays testable. */
export type CvdPaletteCardActions = CvdPaletteActions & {
  /** The colours the climber last set BY HAND, or `null` if they never have. */
  loadCustomColors: () => Promise<HoldColorOverrides | null>;
};

/**
 * Apply a card from the rail. The one write path, so the rail and any future
 * surface cannot drift on what pressing a card does.
 *
 * `default` clears the four colour overrides and NOTHING else. Marker shape,
 * brush and size belong to the Hold markers section, and its own "Reset hold
 * markers" is what owns them — a climber picking a palette is answering a
 * question about colour, and taking their marker shapes away with it would be a
 * second, unasked-for reset.
 *
 * `custom` restores the hand-set colours, and is a no-op when there are none:
 * there is nothing to go back to, and reading "Custom" as "clear everything"
 * would destroy the palette they are on to give them nothing.
 */
export async function applyCvdPaletteCard(id: CvdPaletteOptionId, actions: CvdPaletteCardActions): Promise<void> {
  if (id === 'default') {
    for (const role of HOLD_COLOR_OVERRIDE_ROLES) actions.setRoleOverride(role, null);
    return;
  }
  if (id === 'custom') {
    const customColors = await actions.loadCustomColors();
    if (!customColors) return;
    for (const role of HOLD_COLOR_OVERRIDE_ROLES) actions.setRoleOverride(role, customColors[role] ?? null);
    return;
  }
  applyCvdPalette(id, actions);
}
