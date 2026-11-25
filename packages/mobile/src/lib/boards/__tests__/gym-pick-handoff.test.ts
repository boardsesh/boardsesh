// The builders' gym row pushes /boards/gym-picker and takes the answer back
// through an addressed handoff, so a second form mounted under the picker
// never takes a pick meant for another.
import { describe, expect, it } from 'vitest';
import {
  createGymPickHandoffId,
  emitGymPick,
  gymPickerHref,
  readGymPickerParams,
  subscribeToGymPicks,
  type GymPick,
} from '../gym-pick-handoff';

describe('gymPickerHref', () => {
  it("carries the form's address, the current gym and the board's position", () => {
    const href = gymPickerHref({
      handoffId: 'gym-pick-7',
      currentGymUuid: 'gym-1',
      boardCoords: { latitude: 52.37, longitude: 4.9 },
      showsOnMap: false,
    });
    expect(href).toEqual({
      pathname: '/boards/gym-picker',
      params: { handoffId: 'gym-pick-7', gymUuid: 'gym-1', latitude: '52.37', longitude: '4.9', showsOnMap: '0' },
    });
    expect(readGymPickerParams(href.params)).toEqual({
      handoffId: 'gym-pick-7',
      currentGymUuid: 'gym-1',
      boardCoords: { latitude: 52.37, longitude: 4.9 },
      showsOnMap: false,
    });
  });

  it('leaves out a gym and a position the board does not have', () => {
    const href = gymPickerHref({ handoffId: 'gym-pick-8', currentGymUuid: null, boardCoords: null, showsOnMap: true });
    expect(href.params).toEqual({ handoffId: 'gym-pick-8', showsOnMap: '1' });
    expect(readGymPickerParams(href.params)).toEqual({
      handoffId: 'gym-pick-8',
      currentGymUuid: null,
      boardCoords: null,
      showsOnMap: true,
    });
  });

  it('reads a malformed link as no address and no position', () => {
    expect(readGymPickerParams({ latitude: 'north', longitude: '200' })).toEqual({
      handoffId: '',
      currentGymUuid: null,
      boardCoords: null,
      showsOnMap: true,
    });
  });
});

describe('the gym pick handoff', () => {
  it('reaches only the form it is addressed to', () => {
    const first = createGymPickHandoffId();
    const second = createGymPickHandoffId();
    expect(first).not.toBe(second);
    const firstPicks: GymPick[] = [];
    const secondPicks: GymPick[] = [];
    const stopFirst = subscribeToGymPicks(first, (pick) => firstPicks.push(pick));
    const stopSecond = subscribeToGymPicks(second, (pick) => secondPicks.push(pick));
    emitGymPick(first, { kind: 'none' });
    emitGymPick('', { kind: 'not_listed' });
    expect(firstPicks).toEqual([{ kind: 'none' }]);
    expect(secondPicks).toEqual([]);
    stopFirst();
    stopSecond();
  });
});
