import { describe, expect, it } from 'vitest';
import { isPickableBoardType, likelyBoardType, lookupState, notListedRowState } from '../find-wall-state';

describe('lookupState', () => {
  const base = { enabled: true, offline: false, isLoading: false, isError: false, count: null };
  it.each([
    { name: 'nothing to look up yet', input: { ...base, enabled: false }, state: 'idle' },
    { name: 'the first load', input: { ...base, isLoading: true }, state: 'loading' },
    { name: 'no answer yet', input: base, state: 'loading' },
    { name: 'walls listed', input: { ...base, count: 3 }, state: 'listed' },
    { name: 'none listed', input: { ...base, count: 0 }, state: 'empty' },
    // A failure is never an empty list.
    { name: 'a failed lookup', input: { ...base, isError: true }, state: 'failed' },
    { name: 'a failed refetch of an empty answer', input: { ...base, isError: true, count: 0 }, state: 'failed' },
    { name: 'offline with nothing cached', input: { ...base, offline: true }, state: 'offline' },
    { name: 'offline with an empty answer', input: { ...base, offline: true, count: 0 }, state: 'offline' },
    // Rows on screen stay through a refetch, failed or offline.
    { name: 'walls kept through a failed refetch', input: { ...base, isError: true, count: 2 }, state: 'listed' },
    { name: 'walls kept offline', input: { ...base, offline: true, count: 2 }, state: 'listed' },
  ] as const)('$name', ({ input, state }) => {
    expect(lookupState(input)).toBe(state);
  });
});

describe('notListedRowState', () => {
  it.each([
    { walls: 'loading', signedIn: true, gymLinkable: true, state: 'hidden' },
    { walls: 'offline', signedIn: true, gymLinkable: true, state: 'hidden' },
    { walls: 'idle', signedIn: true, gymLinkable: true, state: 'hidden' },
    { walls: 'listed', signedIn: false, gymLinkable: true, state: 'sign_in' },
    { walls: 'empty', signedIn: false, gymLinkable: true, state: 'sign_in' },
    { walls: 'listed', signedIn: true, gymLinkable: false, state: 'report' },
    { walls: 'empty', signedIn: true, gymLinkable: false, state: 'report' },
    { walls: 'listed', signedIn: true, gymLinkable: true, state: 'confirm' },
    { walls: 'failed', signedIn: true, gymLinkable: true, state: 'add_anyway' },
    // Nothing listed: nothing to confirm against.
    { walls: 'empty', signedIn: true, gymLinkable: true, state: 'direct' },
  ] as const)('$walls, signed in $signedIn, linkable $gymLinkable: $state', ({ state, ...input }) => {
    expect(notListedRowState(input)).toBe(state);
  });
});

describe('likelyBoardType', () => {
  it('opens on the type the gym has most of', () => {
    expect(likelyBoardType([{ boardType: 'kilter' }, { boardType: 'moonboard' }, { boardType: 'moonboard' }])).toBe(
      'moonboard',
    );
  });

  it('breaks a tie in the supported order', () => {
    expect(likelyBoardType([{ boardType: 'tension' }, { boardType: 'kilter' }])).toBe('kilter');
  });

  it.each([{ boards: undefined }, { boards: [] }, { boards: [{ boardType: 'spray' }] }])(
    'asks when the gym has nothing to go on: $boards',
    ({ boards }) => {
      expect(likelyBoardType(boards)).toBeNull();
    },
  );
});

describe('isPickableBoardType', () => {
  it.each([
    { boardType: 'kilter', pickable: true },
    { boardType: 'moonboard', pickable: true },
    // A spray wall has its own wizard.
    { boardType: 'spray', pickable: false },
    { boardType: 'not-a-board', pickable: false },
    { boardType: null, pickable: false },
  ])('$boardType: $pickable', ({ boardType, pickable }) => {
    expect(isPickableBoardType(boardType)).toBe(pickable);
  });
});
