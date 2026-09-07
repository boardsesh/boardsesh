import { describe, it, expect } from 'vite-plus/test';
import type { CncCatalogEntry } from '@boardsesh/shared-schema';
import {
  CNC_ENGRAVE_OPTION_KEYS,
  configKey,
  configuratorReducer,
  defaultOptions,
  engraveOptions,
  finaliseBlockers,
  fromDraft,
  isPreviewStale,
  hasKickerSets,
  initialConfiguratorState,
  optionValueKey,
  setIdsFor,
  toBoardConfigInput,
  toDraft,
  visibleMachiningOptions,
  type CncConfiguratorState,
} from '../configurator/configurator-state';

/**
 * A trimmed stand-in for the real catalogue, carrying one option of every
 * shape the backend actually publishes: a string, a fractional number, a
 * kicker-only number, and the two booleans that are engrave toggles.
 */
function tenByTwelve(): CncCatalogEntry {
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
      {
        key: 'tnutHoleDiameterMm',
        values: ['11.1', '12.5'],
        defaultValue: '12.5',
        valueType: 'number',
        kickerOnly: false,
      },
      {
        key: 'kickerMatClearanceMm',
        values: ['50', '75'],
        defaultValue: '50',
        valueType: 'number',
        kickerOnly: true,
      },
      {
        key: 'engraveHoldIds',
        values: ['false', 'true'],
        defaultValue: 'false',
        valueType: 'boolean',
        kickerOnly: false,
      },
      {
        key: 'engraveAngleTicks',
        values: ['false', 'true'],
        defaultValue: 'false',
        valueType: 'boolean',
        kickerOnly: false,
      },
    ],
    tiers: [
      { tier: 'personal', amountCents: 14900, currency: 'AUD' },
      { tier: 'commercial_single', amountCents: 75000, currency: 'AUD' },
    ],
  };
}

/** A 10 ft wall: no kicker sets at all, so nothing to opt out of. */
function sevenByTen(): CncCatalogEntry {
  return { ...tenByTwelve(), sizeId: 17, setIds: '26,27', label: '7x10', kickerOptional: false };
}

describe('option defaults', () => {
  it('fills every published option from the catalogue, not from a hardcoded list', () => {
    expect(defaultOptions(tenByTwelve())).toEqual({
      sheetStock: '2440x1220',
      tnutHoleDiameterMm: '12.5',
      kickerMatClearanceMm: '50',
      engraveHoldIds: 'false',
      engraveAngleTicks: 'false',
    });
  });

  it('opens with the kicker IN on a wall that has one', () => {
    // Opt-out, not opt-in: a buyer who never noticed the toggle gets the wall
    // they expected rather than a pack missing its bottom row.
    expect(initialConfiguratorState(tenByTwelve()).includeKicker).toBe(true);
    expect(initialConfiguratorState(sevenByTen()).includeKicker).toBe(false);
  });

  it('resets options to the new size’s defaults when the size changes, and keeps the buyer', () => {
    const start: CncConfiguratorState = {
      ...initialConfiguratorState(tenByTwelve()),
      options: { ...defaultOptions(tenByTwelve()), sheetStock: '3600x1220' },
      licenseeName: 'Sam',
      licenseeEmail: 'sam@example.com',
    };

    const next = configuratorReducer(start, { type: 'selectSize', entry: sevenByTen() });

    // A value carried onto a size that does not allow it is a checkout the
    // backend rejects with an error the buyer cannot act on.
    expect(next.options.sheetStock).toBe('2440x1220');
    expect(next.sizeId).toBe(17);
    expect({ name: next.licenseeName, email: next.licenseeEmail }).toEqual({
      name: 'Sam',
      email: 'sam@example.com',
    });
  });

  it('clears the customer site name when the tier drops back to personal', () => {
    const commercial: CncConfiguratorState = {
      ...initialConfiguratorState(tenByTwelve()),
      tier: 'commercial_single',
      customerSiteName: 'Northside Boulder',
    };

    expect(configuratorReducer(commercial, { type: 'setTier', tier: 'personal' }).customerSiteName).toBe('');
  });
});

describe('kicker-only and engrave options', () => {
  it('hides a kickerOnly option once the kicker is off', () => {
    const entry = tenByTwelve();
    const withKicker = visibleMachiningOptions(entry, true).map((option) => option.key);
    const withoutKicker = visibleMachiningOptions(entry, false).map((option) => option.key);

    expect(withKicker).toContain('kickerMatClearanceMm');
    expect(withoutKicker).not.toContain('kickerMatClearanceMm');
  });

  it('keeps the engrave toggles out of the machining step in both cases', () => {
    for (const includeKicker of [true, false]) {
      const keys = visibleMachiningOptions(tenByTwelve(), includeKicker).map((option) => option.key);
      for (const engraveKey of CNC_ENGRAVE_OPTION_KEYS) {
        expect(keys).not.toContain(engraveKey);
      }
    }
  });

  it('serves the engrave toggles their own list, in catalogue order', () => {
    expect(engraveOptions(tenByTwelve()).map((option) => option.key)).toEqual(['engraveHoldIds', 'engraveAngleTicks']);
  });
});

describe('set ids', () => {
  it('drops both kicker sets together when the kicker is off', () => {
    expect(setIdsFor(tenByTwelve(), true)).toBe('26,27,28,29');
    // Never one of them: the backend rejects half a kicker outright.
    expect(setIdsFor(tenByTwelve(), false)).toBe('26,27');
  });

  it('leaves a kickerless wall alone', () => {
    expect(hasKickerSets(sevenByTen())).toBe(false);
    expect(setIdsFor(sevenByTen(), false)).toBe('26,27');
  });
});

describe('config to mutation input', () => {
  it('coerces every option back to the type the catalogue holds it as', () => {
    const state = initialConfiguratorState(tenByTwelve());
    const input = toBoardConfigInput(state, tenByTwelve());

    expect(input.options).toEqual({
      sheetStock: '2440x1220',
      tnutHoleDiameterMm: 12.5,
      kickerMatClearanceMm: 50,
      engraveHoldIds: false,
      engraveAngleTicks: false,
    });
  });

  it('sends only keys the entry still publishes, never a leftover from another size', () => {
    const state: CncConfiguratorState = {
      ...initialConfiguratorState(tenByTwelve()),
      options: { ...defaultOptions(tenByTwelve()), retiredOption: 'whatever' },
    };

    // The backend rejects unknown option keys rather than dropping them, so a
    // stale key that reached the wire would fail the whole checkout.
    expect(Object.keys(toBoardConfigInput(state, tenByTwelve()).options)).not.toContain('retiredOption');
  });

  it('carries the board tuple and the kicker decision through as one unit', () => {
    const state = { ...initialConfiguratorState(tenByTwelve()), includeKicker: false };
    expect(toBoardConfigInput(state, tenByTwelve())).toMatchObject({
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 25,
      setIds: '26,27',
    });
  });
});

describe('finalise gate', () => {
  const ready: CncConfiguratorState = {
    ...initialConfiguratorState(tenByTwelve()),
    licenseeName: 'Sam Bouldering',
    licenseeEmail: 'sam@example.com',
    licenceAccepted: true,
  };

  it('lets a complete personal order through', () => {
    expect(finaliseBlockers(ready)).toEqual([]);
  });

  it('blocks on a missing name, a broken email, and an unaccepted licence', () => {
    expect(finaliseBlockers({ ...ready, licenseeName: '   ' })).toContain('licenseeName');
    expect(finaliseBlockers({ ...ready, licenseeEmail: 'sam@example' })).toContain('licenseeEmail');
    expect(finaliseBlockers({ ...ready, licenceAccepted: false })).toContain('licenceAccepted');
  });

  it('requires a customer site name only for a commercial licence', () => {
    const commercial = { ...ready, tier: 'commercial_single' as const, customerSiteName: '' };
    expect(finaliseBlockers(commercial)).toContain('customerSiteName');
    expect(finaliseBlockers({ ...commercial, customerSiteName: 'Northside Boulder' })).toEqual([]);
  });
});

describe('preview pointers', () => {
  const previewed = configuratorReducer(initialConfiguratorState(tenByTwelve()), {
    type: 'previewCreated',
    orderId: '41',
    licenceId: 'BS-CNC-K7QM3T',
    configKey: 'the-wall-that-was-previewed',
  });

  it('remembers which order to poll and which to finalise', () => {
    expect({
      orderId: previewed.previewOrderId,
      licenceId: previewed.previewLicenceId,
      key: previewed.previewConfigKey,
    }).toEqual({ orderId: '41', licenceId: 'BS-CNC-K7QM3T', key: 'the-wall-that-was-previewed' });
  });

  it('is stale the moment the wall on screen stops matching the one previewed', () => {
    expect(isPreviewStale(previewed, 'the-wall-that-was-previewed')).toBe(false);
    expect(isPreviewStale(previewed, 'a-thicker-panel')).toBe(true);
  });

  it('is never stale before there is a preview at all', () => {
    const fresh = initialConfiguratorState(tenByTwelve());
    expect(isPreviewStale(fresh, configKey(toBoardConfigInput(fresh, tenByTwelve())))).toBe(false);
  });

  it('gives one wall one key, and two walls two', () => {
    const wall = initialConfiguratorState(tenByTwelve());
    const thicker: CncConfiguratorState = {
      ...wall,
      options: { ...defaultOptions(tenByTwelve()), sheetStock: '3600x1220' },
    };

    expect(configKey(toBoardConfigInput(wall, tenByTwelve()))).toBe(configKey(toBoardConfigInput(wall, tenByTwelve())));
    expect(configKey(toBoardConfigInput(thicker, tenByTwelve()))).not.toBe(
      configKey(toBoardConfigInput(wall, tenByTwelve())),
    );
  });
});

describe('draft persistence', () => {
  it('never stores licence acceptance', () => {
    const draft = toDraft({ ...initialConfiguratorState(tenByTwelve()), licenceAccepted: true });
    // Acceptance is an act. Restoring it would let a browser that ticked the box
    // once arrive at checkout pre-accepted without anyone reading anything.
    expect(Object.keys(draft)).not.toContain('licenceAccepted');
  });

  it('round-trips a configuration and comes back un-accepted', () => {
    const state: CncConfiguratorState = {
      ...initialConfiguratorState(tenByTwelve()),
      options: { ...defaultOptions(tenByTwelve()), sheetStock: '3600x1220' },
      tier: 'commercial_single',
      licenseeName: 'Sam',
      licenseeEmail: 'sam@example.com',
      customerSiteName: 'Northside Boulder',
      licenceAccepted: true,
    };

    const restored = fromDraft(JSON.parse(JSON.stringify(toDraft(state))), [tenByTwelve(), sevenByTen()]);

    expect(restored).toMatchObject({
      sizeId: 25,
      tier: 'commercial_single',
      customerSiteName: 'Northside Boulder',
      licenceAccepted: false,
    });
    expect(restored?.options.sheetStock).toBe('3600x1220');
  });

  it('brings the preview back with the wall, so a reload resumes the gallery', () => {
    const state = configuratorReducer(initialConfiguratorState(tenByTwelve()), {
      type: 'previewCreated',
      orderId: '41',
      licenceId: 'BS-CNC-K7QM3T',
      configKey: 'the-wall-that-was-previewed',
    });

    const restored = fromDraft(JSON.parse(JSON.stringify(toDraft(state))), [tenByTwelve()]);

    expect(restored).toMatchObject({
      previewOrderId: '41',
      previewLicenceId: 'BS-CNC-K7QM3T',
      previewConfigKey: 'the-wall-that-was-previewed',
    });
  });

  it('drops a half-written preview pointer rather than restoring a gallery it cannot check', () => {
    // A licence id with no config key behind it would come back looking fresh
    // however much the buyer had changed since.
    const draft = { ...toDraft(initialConfiguratorState(tenByTwelve())), previewLicenceId: 'BS-CNC-K7QM3T' };

    expect(fromDraft(draft, [tenByTwelve()])).toMatchObject({
      previewOrderId: null,
      previewLicenceId: null,
      previewConfigKey: null,
    });
  });

  it('falls back to today’s default for an option value the catalogue has dropped', () => {
    const draft = { ...toDraft(initialConfiguratorState(tenByTwelve())), options: { sheetStock: '1200x600' } };

    expect(fromDraft(draft, [tenByTwelve()])?.options.sheetStock).toBe('2440x1220');
  });

  it('discards a draft whose board tuple is no longer on sale', () => {
    const draft = { ...toDraft(initialConfiguratorState(tenByTwelve())), sizeId: 999 };

    expect(fromDraft(draft, [tenByTwelve(), sevenByTen()])).toBeNull();
  });

  it('discards anything that is not a draft at all', () => {
    for (const value of [null, undefined, 'draft', 42, [], { sizeId: '25' }]) {
      expect(fromDraft(value, [tenByTwelve()])).toBeNull();
    }
  });
});

describe('option value keys', () => {
  it('maps every character i18next would read structurally', () => {
    // The catalogs are written against this function: `12.5` must not nest a
    // `12` object with a `5` inside it.
    expect(optionValueKey('12.5')).toBe('12_5');
    expect(optionValueKey('101.6')).toBe('101_6');
    expect(optionValueKey('2440x1220')).toBe('2440x1220');
    expect(optionValueKey('R12_circles')).toBe('R12_circles');
    expect(optionValueKey('true')).toBe('true');
  });
});
