import { describe, expect, it } from 'vitest';
import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '../board-catalogue-cascade';
import {
  boardSetupLabelParts,
  boardSetupSummary,
  setupAngleLabel,
  setupLayoutLabel,
  setupSizeLabel,
} from '../setup-labels';

// Real catalogue rows, found by name rather than by id, so a refresh that
// renumbers nothing still reads the same words.
const kilterOriginal = getBoardLayouts('kilter').find((layout) => layout.name === 'Kilter Board Original');
if (!kilterOriginal) throw new Error('Expected the Kilter Board Original layout in the catalogue');
const kilterSize = getBoardSizesForLayoutId('kilter', kilterOriginal.id).find((size) => size.name === '12 x 14');
if (!kilterSize) throw new Error('Expected a 12 x 14 Kilter Original size in the catalogue');
const kilterSets = getBoardSetsForLayoutAndSize('kilter', kilterOriginal.id, kilterSize.id);

describe('setup option labels', () => {
  it('cleans the brand off a layout', () => {
    expect(setupLayoutLabel('kilter', { name: 'Kilter Board Original' })).toBe('Original');
    expect(setupLayoutLabel('tension', { name: 'Tension Board 2 Mirror' })).toBe('Mirror');
    expect(setupLayoutLabel('moonboard', { name: 'MoonBoard 2016' })).toBe('2016');
  });

  it('names a size by its dimensions and kit', () => {
    expect(setupSizeLabel({ name: '10 x 12', description: 'Full Ride LED Kit' })).toBe('10×12 · Full Ride');
    expect(setupSizeLabel({ name: '12 x 14', description: 'Commercial' })).toBe('12×14 · Commercial');
    expect(setupSizeLabel({ name: '8 x 10', description: '' })).toBe('8×10');
    expect(setupSizeLabel({ name: '8 x 10' })).toBe('8×10');
  });

  it('writes an angle in degrees', () => {
    expect(setupAngleLabel(40)).toBe('40°');
  });
});

describe('boardSetupLabelParts', () => {
  it('names every part from the catalogue, sets in catalogue order', () => {
    const reversed = [...kilterSets].reverse().map((set) => set.id);
    expect(
      boardSetupLabelParts('kilter', {
        layoutId: kilterOriginal.id,
        sizeId: kilterSize.id,
        setIds: reversed.join(','),
      }),
    ).toEqual({
      layout: 'Original',
      size: setupSizeLabel(kilterSize),
      sets: kilterSets.map((set) => set.name),
      angle: null,
    });
  });

  it('leaves out what the catalogue does not know', () => {
    expect(boardSetupLabelParts('kilter', { layoutId: -1, sizeId: -1, setIds: '-5', angle: 25 })).toEqual({
      layout: null,
      size: null,
      sets: [],
      angle: '25°',
    });
    expect(boardSetupLabelParts('not-a-board', { layoutId: 1, sizeId: 1, setIds: '1' })).toEqual({
      layout: null,
      size: null,
      sets: [],
      angle: null,
    });
  });
});

describe('boardSetupSummary', () => {
  it('puts the setup on one line, with the angle only when there is one', () => {
    const setIds = kilterSets.map((set) => set.id);
    const sets = kilterSets.map((set) => set.name).join(', ');
    const size = setupSizeLabel(kilterSize);
    expect(boardSetupSummary('kilter', { layoutId: kilterOriginal.id, sizeId: kilterSize.id, setIds })).toBe(
      `Original · ${size} · ${sets}`,
    );
    expect(boardSetupSummary('kilter', { layoutId: kilterOriginal.id, sizeId: kilterSize.id, setIds, angle: 40 })).toBe(
      `Original · ${size} · ${sets} · 40°`,
    );
  });

  it('falls back to the board type, never to raw ids', () => {
    expect(boardSetupSummary('kilter', { layoutId: -1, sizeId: -1, setIds: '' })).toBe('Kilter');
  });
});
