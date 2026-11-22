import { describe, it, expect } from 'vite-plus/test';
import { HOLD_STATE_MAP, getHoldDisplayColor, summarizeHoldRoles } from '../hold-states';

// Kilter Original role codes: 12 STARTING, 13 HAND, 14 FINISH, 15 FOOT.
describe('summarizeHoldRoles', () => {
  it('returns nothing for empty or missing frames', () => {
    expect(summarizeHoldRoles('kilter', '')).toEqual([]);
    expect(summarizeHoldRoles('kilter', null)).toEqual([]);
    expect(summarizeHoldRoles('kilter', undefined)).toEqual([]);
  });

  it('counts each role in start, hand, finish, foot order whatever the frame order', () => {
    const summary = summarizeHoldRoles('kilter', 'p9r15p1r14p2r13p3r12p4r13p5r12p6r15p7r15');
    expect(summary.map(({ role, count }) => [role, count])).toEqual([
      ['STARTING', 2],
      ['HAND', 2],
      ['FINISH', 1],
      ['FOOT', 3],
    ]);
  });

  it('leaves out roles the climb does not use', () => {
    // MoonBoard climbs have no foot holds.
    const summary = summarizeHoldRoles('moonboard', 'p1r42p2r43p3r43p4r44');
    expect(summary.map(({ role }) => role)).toEqual(['STARTING', 'HAND', 'FINISH']);
  });

  it('paints each role in the Aura screen colour the render uses', () => {
    const summary = summarizeHoldRoles('kilter', 'p1r12p2r13p3r14p4r15');
    expect(Object.fromEntries(summary.map(({ role, color }) => [role, color]))).toEqual({
      STARTING: '#00FF00',
      HAND: '#4DF5FD',
      FINISH: '#FF00FF',
      FOOT: '#FFAA00',
    });
    // Tension draws its own display colours, with the shared Aura hand cyan.
    const tension = summarizeHoldRoles('tension', 'p1r1p2r2p3r3p4r4');
    expect(tension.map(({ color }) => color)).toEqual(['#00DD00', '#4DF5FD', '#FF0000', '#FF00FF']);
  });

  it('falls back to the first code mapped to a role when the board has no canonical one', () => {
    // MoonBoard's only FOOT is the firmware preview code 45.
    const [foot] = summarizeHoldRoles('moonboard', 'p1r45');
    expect(foot).toEqual({ role: 'FOOT', count: 1, color: getHoldDisplayColor(HOLD_STATE_MAP.moonboard[45], 'aura') });
  });

  it('counts what a static render shows on a multi-frame climb: the union, last role winning', () => {
    // Frame 1 lights 1 as a start and 2 as a hand; the delta frame re-roles 2 as
    // a finish and adds 3 as a foot. Nothing is turned off, so all three show.
    const summary = summarizeHoldRoles('kilter', 'p1r12p2r13,"p2r14p3r15');
    expect(summary.map(({ role, count }) => [role, count])).toEqual([
      ['STARTING', 1],
      ['FINISH', 1],
      ['FOOT', 1],
    ]);
  });

  it('ignores unknown role codes rather than counting the sentinel', () => {
    const summary = summarizeHoldRoles('kilter', 'p1r12p2r999');
    expect(summary).toEqual([{ role: 'STARTING', count: 1, color: '#00FF00' }]);
  });
});
