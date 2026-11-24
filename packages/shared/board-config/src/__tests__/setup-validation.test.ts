import { describe, expect, it } from 'vitest';
import { MOONBOARD_LAYOUTS, MOONBOARD_SIZE } from '../moonboard-metadata';
import { findUnknownSetupField } from '../setup-selection';

const MASTERS_2019 = MOONBOARD_LAYOUTS['moonboard-masters-2019'].id;
const MOONBOARD_2016 = MOONBOARD_LAYOUTS['moonboard-2016'].id;

describe('findUnknownSetupField', () => {
  it('passes a setup the catalogue lists, in any set order', () => {
    expect(
      findUnknownSetupField('moonboard', { layoutId: MASTERS_2019, sizeId: MOONBOARD_SIZE.id, setIds: [20, 17, 18] }),
    ).toBeNull();
  });

  it('leaves an incomplete setup to the Save gate', () => {
    expect(findUnknownSetupField('moonboard', { layoutId: null, sizeId: null, setIds: [] })).toBeNull();
    expect(findUnknownSetupField('moonboard', { layoutId: MASTERS_2019, sizeId: null, setIds: [] })).toBeNull();
  });

  it('names the layout first, then the size, in the server refusal order', () => {
    expect(findUnknownSetupField('moonboard', { layoutId: 999, sizeId: 12345, setIds: [1] })).toEqual({
      field: 'layoutId',
      invalidSetIds: [],
    });
    expect(findUnknownSetupField('moonboard', { layoutId: MASTERS_2019, sizeId: 12345, setIds: [17] })).toEqual({
      field: 'sizeId',
      invalidSetIds: [],
    });
  });

  it('lists the sets the size does not have, ascending and once each', () => {
    // Sets 2 and 3 are the 2016 board's; a Masters 2019 setup can't carry them.
    expect(
      findUnknownSetupField('moonboard', { layoutId: MASTERS_2019, sizeId: MOONBOARD_SIZE.id, setIds: [3, 17, 2, 3] }),
    ).toEqual({ field: 'setIds', invalidSetIds: [2, 3] });
    expect(
      findUnknownSetupField('moonboard', { layoutId: MOONBOARD_2016, sizeId: MOONBOARD_SIZE.id, setIds: [2, 3, 4] }),
    ).toBeNull();
  });
});
