import { describe, expect, it } from 'vitest';
import { MOONBOARD_LAYOUTS, boardSupportsMirroring, coordinateToHoldId } from '@boardsesh/board-config';
import type { MoonBoardCoordinate } from '@boardsesh/board-config';
import { summarizeActiveHolds } from '../active-holds';

function moonHold(coordinate: MoonBoardCoordinate, roleCode: number): string {
  return `p${coordinateToHoldId(coordinate)}r${roleCode}`;
}

describe('summarizeActiveHolds', () => {
  it('labels MoonBoard holds bottom to top, left to right, whatever order the frames list them', () => {
    // The sample from #6290, stored in the setter's order.
    const frames = [
      moonHold('B5', 42),
      moonHold('H13', 43),
      moonHold('I14', 43),
      moonHold('F10', 43),
      moonHold('K8', 43),
      moonHold('F8', 43),
      moonHold('J18', 44),
    ].join('');
    expect(summarizeActiveHolds('moonboard', frames)).toEqual({
      hasLabels: true,
      groups: [
        { role: 'STARTING', count: 1, labels: ['B5'] },
        { role: 'HAND', count: 5, labels: ['F8', 'K8', 'F10', 'H13', 'I14'] },
        { role: 'FINISH', count: 1, labels: ['J18'] },
      ],
    });
  });

  it('labels a MoonBoard live-preview foot hold too, and skips AUX', () => {
    const frames = [moonHold('C2', 45), moonHold('A1', 45), moonHold('D6', 46), moonHold('E9', 43)].join('');
    expect(summarizeActiveHolds('moonboard', frames).groups).toEqual([
      { role: 'HAND', count: 1, labels: ['E9'] },
      { role: 'FOOT', count: 2, labels: ['A1', 'C2'] },
    ]);
  });

  it('leaves out a MoonBoard hold off the 11 × 18 grid', () => {
    // 199 is one past K18; neither it nor 250 has a coordinate on the wall.
    expect(summarizeActiveHolds('moonboard', `p199r45p250r45${moonHold('E9', 43)}`).groups).toEqual([
      { role: 'HAND', count: 1, labels: ['E9'] },
    ]);
  });

  it('returns no groups for an AUX-only MoonBoard frame, still with labels', () => {
    expect(summarizeActiveHolds('moonboard', [moonHold('D6', 46), moonHold('E7', 46)].join(''))).toEqual({
      groups: [],
      hasLabels: true,
    });
  });

  it('counts every hand colour as one Hand group', () => {
    // Kilter Tycho colour codes, and MoonBoard's live-preview hand colours.
    expect(summarizeActiveHolds('kilter', 'p1r36p2r37p3r38p4r39p5r40p6r41').groups).toEqual([
      { role: 'HAND', count: 6, labels: null },
    ]);
    expect(
      summarizeActiveHolds('moonboard', [moonHold('A3', 43), moonHold('B4', 47), moonHold('C5', 48)].join('')).groups,
    ).toEqual([{ role: 'HAND', count: 3, labels: ['A3', 'B4', 'C5'] }]);
  });

  it('counts roles on boards without wall coordinates, in start, hand, finish, foot order', () => {
    // Kilter Original (12-15) and Homewall (42-45) codes together.
    const kilter = 'p1r15p2r13p3r12p4r44p5r43p6r42p7r13p8r45';
    expect(summarizeActiveHolds('kilter', kilter)).toEqual({
      hasLabels: false,
      groups: [
        { role: 'STARTING', count: 2, labels: null },
        { role: 'HAND', count: 3, labels: null },
        { role: 'FINISH', count: 1, labels: null },
        { role: 'FOOT', count: 2, labels: null },
      ],
    });
    expect(summarizeActiveHolds('tension', 'p10r1p20r2p30r3p40r4p50r8').groups.map((group) => group.count)).toEqual([
      1, 1, 1, 2,
    ]);
  });

  it('reads Woods and spray walls through their own role codes', () => {
    // Woods: foot is 1, start is 4.
    expect(summarizeActiveHolds('woods', 'p1r4p2r2p3r2p4r3p5r1').groups).toEqual([
      { role: 'STARTING', count: 1, labels: null },
      { role: 'HAND', count: 2, labels: null },
      { role: 'FINISH', count: 1, labels: null },
      { role: 'FOOT', count: 1, labels: null },
    ]);
    expect(summarizeActiveHolds('spray', 'p7r1p8r3').groups).toEqual([
      { role: 'STARTING', count: 1, labels: null },
      { role: 'FINISH', count: 1, labels: null },
    ]);
  });

  it('reads only the first snapshot, the frame the board paints', () => {
    // Frame 2 turns the start off and lights a finish; neither shows.
    expect(summarizeActiveHolds('kilter', 'p10r12p20r13,"x10p30r14').groups).toEqual([
      { role: 'STARTING', count: 1, labels: null },
      { role: 'HAND', count: 1, labels: null },
    ]);
    // A playback frame arrives as its own comma-free snapshot.
    expect(summarizeActiveHolds('kilter', 'p20r13p30r14').groups).toEqual([
      { role: 'HAND', count: 1, labels: null },
      { role: 'FINISH', count: 1, labels: null },
    ]);
  });

  it('honours off tokens inside the snapshot', () => {
    expect(summarizeActiveHolds('kilter', 'p10r12p20r13x20').groups).toEqual([
      { role: 'STARTING', count: 1, labels: null },
    ]);
  });

  it('skips unknown role codes and returns no groups for an empty climb', () => {
    expect(summarizeActiveHolds('kilter', 'p10r99p20r13').groups).toEqual([{ role: 'HAND', count: 1, labels: null }]);
    expect(summarizeActiveHolds('kilter', '')).toEqual({ groups: [], hasLabels: false });
    expect(summarizeActiveHolds('moonboard', '')).toEqual({ groups: [], hasLabels: true });
  });

  it('never needs a mirrored MoonBoard label, because no MoonBoard layout mirrors', () => {
    // If a MoonBoard layout ever mirrors, labels must be remapped with the
    // holds; this fails first so the line can't show the unmirrored wall.
    for (const layout of Object.values(MOONBOARD_LAYOUTS)) {
      expect(boardSupportsMirroring('moonboard', layout.id)).toBe(false);
    }
  });
});
