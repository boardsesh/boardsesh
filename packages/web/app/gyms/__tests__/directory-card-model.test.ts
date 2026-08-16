import { describe, it, expect } from 'vite-plus/test';
import { boardChips, cardLocation, roundDistanceKm } from '../directory-card-model';

describe('boardChips', () => {
  it('is empty when the gym reported no boards', () => {
    expect(boardChips([])).toEqual([]);
    expect(boardChips(null)).toEqual([]);
    expect(boardChips(undefined)).toEqual([]);
  });

  it('collapses identical board/angle pairs to one chip', () => {
    expect(
      boardChips([
        { boardType: 'kilter', angle: 40 },
        { boardType: 'kilter', angle: 40 },
        { boardType: 'kilter', angle: 40 },
      ]),
    ).toEqual([{ key: 'kilter-40', boardType: 'kilter', angle: 40 }]);
  });

  it('keeps distinct angles of the same board', () => {
    expect(
      boardChips([
        { boardType: 'kilter', angle: 50 },
        { boardType: 'kilter', angle: 40 },
      ]).map((chip) => chip.angle),
    ).toEqual([40, 50]);
  });

  it('orders by the shared board-type order, then angle', () => {
    expect(
      boardChips([
        { boardType: 'tension', angle: 40 },
        { boardType: 'moonboard', angle: 25 },
        { boardType: 'kilter', angle: 30 },
      ]).map((chip) => chip.boardType),
    ).toEqual(['kilter', 'tension', 'moonboard']);
  });

  it('sorts a board type it has never heard of last instead of first', () => {
    expect(
      boardChips([
        { boardType: 'mystery-board', angle: 20 },
        { boardType: 'kilter', angle: 40 },
      ]).map((chip) => chip.boardType),
    ).toEqual(['kilter', 'mystery-board']);
  });
});

describe('cardLocation', () => {
  it('prefers the free-text address the gym typed', () => {
    expect(cardLocation({ address: ' 12 Mill Lane, Bristol ', latitude: 1, longitude: 2 }, null)).toEqual({
      kind: 'address',
      address: '12 Mill Lane, Bristol',
    });
  });

  it('falls back to a distance when the request supplied an origin', () => {
    const location = cardLocation(
      { address: null, latitude: 51.3811, longitude: -2.359 },
      {
        latitude: 51.4545,
        longitude: -2.5879,
      },
    );
    expect(location?.kind).toBe('distance');
  });

  it('renders no location line at all for a pin with no origin', () => {
    // There is no city column, so there is nothing honest to print. A
    // synthesised locality would be a wrong address on a real gym.
    expect(cardLocation({ address: '', latitude: 51.38, longitude: -2.35 }, null)).toBeNull();
  });

  it('renders no location line for a gym with neither address nor pin', () => {
    expect(cardLocation({ address: null, latitude: null, longitude: null }, { latitude: 0, longitude: 0 })).toBeNull();
  });
});

describe('roundDistanceKm', () => {
  it('keeps one decimal within walking distance', () => {
    expect(roundDistanceKm(1.24)).toBe(1.2);
  });

  it('drops to whole km once the decimal is noise', () => {
    expect(roundDistanceKm(42.6)).toBe(43);
  });
});
