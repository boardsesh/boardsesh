import { describe, it, expect } from 'vite-plus/test';
import type { CncArtworkRules, CncCatalogEntry } from '@boardsesh/shared-schema';
import {
  CNC_ARTWORK_MODES,
  artworkIssues,
  configuratorReducer,
  fromDraft,
  initialConfiguratorState,
  isArtworkLocallyValid,
  isArtworkReady,
  newArtworkItem,
  toArtworkInputs,
  toBoardConfigInput,
  toDraft,
  type CncArtworkDraft,
  type CncConfiguratorState,
} from '../configurator/configurator-state';

/**
 * The artwork half of the configurator's state.
 *
 * Everything here is a pure function, which is the point: a wrong placement is
 * a paid order the generator cannot build, so the mapping to the mutation input
 * and the local bounds checks are tested without mounting anything.
 */

const RULES: CncArtworkRules = { maxItems: 4, minWidthMm: 40, maxWidthMm: 1200, maxTextChars: 40 };

function entry(): CncCatalogEntry {
  return {
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    label: '10x12',
    kickerOptional: true,
    manufacturingOptions: [
      {
        key: 'sheetStock',
        values: ['2440x1220', '3600x1220'],
        defaultValue: '2440x1220',
        valueType: 'string',
        kickerOnly: false,
      },
    ],
    tiers: [{ tier: 'personal', amountCents: 14900, currency: 'AUD' }],
  };
}

/** A ready-to-send label, with every number inside the rules. */
function label(overrides: Partial<CncArtworkDraft> = {}): CncArtworkDraft {
  return {
    ...newArtworkItem({ rules: RULES, font: 'liberation-sans', id: 'item-1' }),
    text: 'Send it',
    panelIndex: 2,
    xMm: 120,
    yMm: -80,
    widthMm: 300,
    rotationDeg: -90,
    ...overrides,
  };
}

describe('newArtworkItem', () => {
  it('opens at the narrowest allowed width, engraved, with the catalogue default font', () => {
    const item = newArtworkItem({ rules: RULES, font: 'liberation-sans', panelIndex: 3, id: 'x' });

    // Narrow and engraved is the placement most likely to land somewhere legal
    // on a wall already full of keep-outs — the buyer grows it from there.
    expect(item).toEqual({
      id: 'x',
      text: '',
      font: 'liberation-sans',
      mode: CNC_ARTWORK_MODES[0],
      panelIndex: 3,
      xMm: 0,
      yMm: 0,
      widthMm: RULES.minWidthMm,
      rotationDeg: 0,
    });
    expect(item.mode).toBe('engrave');
  });
});

describe('configuratorReducer artwork actions', () => {
  it('adds, patches and removes by id rather than by position', () => {
    const base = initialConfiguratorState(entry());
    const first = label({ id: 'a' });
    const second = label({ id: 'b', text: 'Second' });

    let state = configuratorReducer(base, { type: 'addArtwork', item: first });
    state = configuratorReducer(state, { type: 'addArtwork', item: second });
    state = configuratorReducer(state, { type: 'updateArtwork', id: 'a', patch: { widthMm: 500 } });
    state = configuratorReducer(state, { type: 'removeArtwork', id: 'b' });

    expect(state.artwork).toHaveLength(1);
    expect(state.artwork[0]).toMatchObject({ id: 'a', widthMm: 500, text: 'Send it' });
  });

  it('drops the artwork when the buyer picks a different wall', () => {
    // A placement names a panel index and a millimetre position on ONE wall.
    // Carried across it points somewhere else entirely, which is a collision
    // the buyer never caused.
    const base = configuratorReducer(initialConfiguratorState(entry()), {
      type: 'addArtwork',
      item: label(),
    });

    const switched = configuratorReducer(base, { type: 'selectSize', entry: { ...entry(), sizeId: 17 } });

    expect(switched.artwork).toEqual([]);
  });
});

describe('toArtworkInputs', () => {
  it('re-nests the placement and trims the label', () => {
    expect(toArtworkInputs([label({ text: '  Send it  ' })])).toEqual([
      {
        text: 'Send it',
        font: 'liberation-sans',
        mode: 'engrave',
        placement: { panelIndex: 2, xMm: 120, yMm: -80, widthMm: 300, rotationDeg: -90 },
      },
    ]);
  });

  it('drops an item the buyer has not typed into yet', () => {
    // Sending it would fail validation on a field they have not reached.
    expect(isArtworkReady(label({ text: '   ' }))).toBe(false);
    expect(toArtworkInputs([label({ id: 'a', text: '' }), label({ id: 'b' })])).toHaveLength(1);
  });
});

describe('toBoardConfigInput', () => {
  it('omits artwork entirely when there is none to route', () => {
    // Not an empty array: checkout skips the generator round trip for an order
    // with no artwork, and `[]` still reads as "the buyer placed something".
    const config = toBoardConfigInput(initialConfiguratorState(entry()), entry());
    expect(config.artwork).toBeUndefined();
  });

  it('carries the placed labels through', () => {
    const state: CncConfiguratorState = {
      ...initialConfiguratorState(entry()),
      artwork: [label()],
    };

    expect(toBoardConfigInput(state, entry()).artwork).toEqual([
      {
        text: 'Send it',
        font: 'liberation-sans',
        mode: 'engrave',
        placement: { panelIndex: 2, xMm: 120, yMm: -80, widthMm: 300, rotationDeg: -90 },
      },
    ]);
  });
});

describe('artworkIssues', () => {
  it('passes a label inside every bound', () => {
    expect(artworkIssues(label(), RULES)).toEqual([]);
    expect(isArtworkLocallyValid([label()], RULES)).toBe(true);
  });

  it('reports an empty label, an over-long one, a bad width and a bad rotation', () => {
    expect(artworkIssues(label({ text: '' }), RULES)).toContain('text');
    expect(artworkIssues(label({ text: 'x'.repeat(41) }), RULES)).toContain('textTooLong');
    expect(artworkIssues(label({ widthMm: 10 }), RULES)).toContain('width');
    expect(artworkIssues(label({ widthMm: 5000 }), RULES)).toContain('width');
    // Signed, not 0..360: the backend rejects 270 rather than normalising it,
    // so a UI that accepted it would be building a rejection.
    expect(artworkIssues(label({ rotationDeg: 270 }), RULES)).toContain('rotation');
  });

  it('treats a non-finite number as out of bounds rather than as zero', () => {
    expect(artworkIssues(label({ widthMm: Number.NaN }), RULES)).toContain('width');
    expect(isArtworkLocallyValid([label({ rotationDeg: Number.NaN })], RULES)).toBe(false);
  });

  it('is vacuously valid with no artwork at all', () => {
    expect(isArtworkLocallyValid([], RULES)).toBe(true);
  });
});

describe('artwork in the saved draft', () => {
  it('survives a round trip through the draft', () => {
    const state: CncConfiguratorState = { ...initialConfiguratorState(entry()), artwork: [label()] };

    const restored = fromDraft(JSON.parse(JSON.stringify(toDraft(state))), [entry()]);

    expect(restored?.artwork).toEqual([label()]);
  });

  it('drops an item with a half-written placement instead of repairing it', () => {
    // A repaired placement would put the buyer's label somewhere they never
    // chose, on a wall they are about to pay for. Losing it is visible.
    const draft = {
      ...toDraft(initialConfiguratorState(entry())),
      artwork: [
        { ...label(), xMm: 'over there' },
        { ...label(), id: 'good' },
      ],
    };

    const restored = fromDraft(JSON.parse(JSON.stringify(draft)), [entry()]);

    expect(restored?.artwork).toHaveLength(1);
    expect(restored?.artwork[0].id).toBe('good');
  });

  it('drops an item whose cut mode is not one we offer', () => {
    const draft = {
      ...toDraft(initialConfiguratorState(entry())),
      artwork: [{ ...label(), mode: 'laser' }],
    };

    expect(fromDraft(JSON.parse(JSON.stringify(draft)), [entry()])?.artwork).toEqual([]);
  });

  it('reads a draft written before artwork existed as no artwork', () => {
    const draft = toDraft(initialConfiguratorState(entry())) as Record<string, unknown>;
    delete draft.artwork;

    expect(fromDraft(draft, [entry()])?.artwork).toEqual([]);
  });
});
