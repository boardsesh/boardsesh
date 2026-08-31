import { describe, expect, it } from 'vitest';
import {
  CVD_PALETTE_OPTIONS,
  applyCvdPaletteCard,
  selectedCvdPaletteCardId,
  type CvdPaletteCardActions,
} from '../cvd-palette-options';
import { CVD_PALETTE_PRESETS, matchingCvdPaletteId } from '../../cvd-palette-presets';
import {
  DEFAULT_HOLD_BRUSH_THICKNESS,
  DEFAULT_HOLD_SHAPE_SIZE,
  type HoldColorOverrideRole,
  type HoldColorOverrides,
  type HoldMarkerOverrides,
  type HoldMarkerShape,
} from '../../hold-color-overrides';

const DEUTERANOPIA_ROLES = CVD_PALETTE_PRESETS.find((preset) => preset.id === 'deuteranopia')!.roles;

/**
 * A stand-in for `useHoldColorOverrides()`'s store, wide enough to catch a write
 * that strays outside the colours: the shape/brush/size setters are here so a
 * card that touched them would show up as a changed field rather than as an
 * un-asserted call.
 */
function fakeMarkerStore(initial: Partial<HoldMarkerOverrides> = {}) {
  const state: HoldMarkerOverrides = {
    colors: {},
    shapes: {},
    brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
    shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
    ...initial,
  };
  return {
    state,
    setRoleOverride(role: HoldColorOverrideRole, color: string | null) {
      if (color) {
        state.colors[role] = color;
      } else {
        delete state.colors[role];
      }
    },
    setRoleShapeOverride(role: HoldColorOverrideRole, shape: HoldMarkerShape) {
      state.shapes[role] = shape;
    },
    setBrushThickness(value: number) {
      state.brushThickness = value;
    },
    setShapeSize(value: number) {
      state.shapeSize = value;
    },
  };
}

function actionsFor(store: ReturnType<typeof fakeMarkerStore>, customColors: HoldColorOverrides | null = null) {
  const actions: CvdPaletteCardActions = {
    setRoleOverride: (role, color) => store.setRoleOverride(role, color),
    loadCustomColors: async () => customColors,
  };
  return { actions };
}

describe('the palette rail, as a list', () => {
  it('offers default, the four palettes and custom, in that order', () => {
    expect(CVD_PALETTE_OPTIONS.map((option) => option.id)).toEqual([
      'default',
      'protanopia',
      'deuteranopia',
      'tritanopia',
      'custom',
    ]);
  });

  it('previews Default with no overrides at all, so it shares the untouched board’s render', () => {
    // `{}`, not `undefined`: an empty map IS the board's own palette, while
    // `undefined` would mean "read the store" and draw whatever they are on.
    expect(CVD_PALETTE_OPTIONS[0].previewRoles).toEqual({});
  });

  it('previews Custom from the store, so it mirrors what the climber actually has', () => {
    expect(CVD_PALETTE_OPTIONS[4].previewRoles).toBeUndefined();
  });

  it('previews each palette in that palette’s own colours', () => {
    const deuteranopia = CVD_PALETTE_OPTIONS.find((option) => option.id === 'deuteranopia');

    expect(deuteranopia?.previewRoles).toEqual({ ...DEUTERANOPIA_ROLES });
  });

  it('borrows the four palette names rather than minting a second set', () => {
    // Two sets of translations for "Protanopia" would drift, and the verdict
    // line names the same three dichromacies.
    const tritanopia = CVD_PALETTE_OPTIONS.find((option) => option.id === 'tritanopia');

    expect(tritanopia?.labelI18nKey).toBe('mobile.more.boardLook.accessibility.cvdPalette.presets.tritanopia');
  });
});

describe('which card is lit', () => {
  it('is Default when the climber has overridden nothing', () => {
    const overrides: HoldColorOverrides = {};

    expect(selectedCvdPaletteCardId(matchingCvdPaletteId(overrides), overrides)).toBe('default');
  });

  it('is the palette when all four roles match it exactly', () => {
    const overrides: HoldColorOverrides = { ...DEUTERANOPIA_ROLES };

    // Protanopia and deuteranopia share one quad, and `matchingCvdPaletteId`
    // returns the first match — so assert against what it actually resolves,
    // not against the id we seeded from.
    expect(selectedCvdPaletteCardId(matchingCvdPaletteId(overrides), overrides)).toBe(matchingCvdPaletteId(overrides));
    expect(selectedCvdPaletteCardId(matchingCvdPaletteId(overrides), overrides)).not.toBe('custom');
  });

  it('is Custom when the colours are the climber’s own', () => {
    const overrides: HoldColorOverrides = { STARTING: '#123456' };

    expect(selectedCvdPaletteCardId(matchingCvdPaletteId(overrides), overrides)).toBe('custom');
  });
});

describe('applying a card', () => {
  it('writes all four role colours for a palette', async () => {
    const store = fakeMarkerStore();

    await applyCvdPaletteCard('deuteranopia', actionsFor(store).actions);

    expect(store.state.colors).toEqual({ ...DEUTERANOPIA_ROLES });
  });

  it('writes colours and nothing else — role glyphs are their own switch', async () => {
    const store = fakeMarkerStore();
    const { actions } = actionsFor(store);

    await applyCvdPaletteCard('tritanopia', actions);

    expect(store.state.shapes).toEqual({});
    expect(Object.keys(store.state.colors)).toHaveLength(4);
  });

  it('clears only the colours for Default — shapes, brush and size are the markers section’s', async () => {
    const store = fakeMarkerStore({
      colors: { ...DEUTERANOPIA_ROLES },
      shapes: { HAND: 'square' },
      brushThickness: 1.6,
      shapeSize: 0.8,
    });

    await applyCvdPaletteCard('default', actionsFor(store).actions);

    expect(store.state.colors).toEqual({});
    expect(store.state.shapes).toEqual({ HAND: 'square' });
    expect(store.state.brushThickness).toBe(1.6);
    expect(store.state.shapeSize).toBe(0.8);
  });

  it('restores the hand-set colours for Custom', async () => {
    const store = fakeMarkerStore({ colors: { ...DEUTERANOPIA_ROLES } });

    await applyCvdPaletteCard('custom', actionsFor(store, { STARTING: '#112233', HAND: '#445566' }).actions);

    // Roles the climber never set by hand go back to the board's own colour,
    // not to whatever the palette left behind.
    expect(store.state.colors).toEqual({ STARTING: '#112233', HAND: '#445566' });
  });

  it('leaves the current colours alone when there is nothing to go back to', async () => {
    // Reading "Custom" as "clear everything" would destroy the palette they are
    // on to give them nothing.
    const store = fakeMarkerStore({ colors: { ...DEUTERANOPIA_ROLES } });

    await applyCvdPaletteCard('custom', actionsFor(store, null).actions);

    expect(store.state.colors).toEqual({ ...DEUTERANOPIA_ROLES });
  });
});
