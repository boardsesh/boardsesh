import { describe, it, expect } from 'vite-plus/test';
import { HOLD_STATE_MAP, getHoldDisplayColor, summarizeHoldRoles } from '../hold-states';

/** `[role, count]` pairs, for assertions that don't care about colour. */
function roleCounts(summary: ReturnType<typeof summarizeHoldRoles>): Array<[string, number]> {
  return summary.map(({ role, count }) => [role, count]);
}

// Kilter Original role codes: 12 STARTING, 13 HAND, 14 FINISH, 15 FOOT.
describe('summarizeHoldRoles', () => {
  it('returns nothing for empty or missing frames', () => {
    expect(summarizeHoldRoles('kilter', '')).toEqual([]);
    expect(summarizeHoldRoles('kilter', null)).toEqual([]);
    expect(summarizeHoldRoles('kilter', undefined)).toEqual([]);
  });

  it('counts each role in start, hand, finish, foot order whatever the frame order', () => {
    const summary = summarizeHoldRoles('kilter', 'p9r15p1r14p2r13p3r12p4r13p5r12p6r15p7r15');
    expect(roleCounts(summary)).toEqual([
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

  it("reads Woods' reversed role codes by role, not by number", () => {
    // Woods wires Foot 1, Hand 2, Finish 3, Start 4: the opposite end from Tension.
    const summary = summarizeHoldRoles('woods', 'p1r4p2r2p3r2p4r3p5r1');
    expect(summary).toEqual([
      { role: 'STARTING', count: 1, color: '#00DD00' },
      { role: 'HAND', count: 2, color: '#4DF5FD' },
      { role: 'FINISH', count: 1, color: '#FF0000' },
      { role: 'FOOT', count: 1, color: '#FF00FF' },
    ]);
  });

  it("uses each code's own colour, including a role the board has no canonical code for", () => {
    // MoonBoard's only FOOT is the firmware preview code 45.
    const [foot] = summarizeHoldRoles('moonboard', 'p1r45');
    expect(foot).toEqual({ role: 'FOOT', count: 1, color: getHoldDisplayColor(HOLD_STATE_MAP.moonboard[45], 'aura') });
  });

  it('gives Tycho colour-mode holds their own colours instead of counting them as cyan hands', () => {
    // 13 is an Original hand (Aura cyan); 37 and 40 are Tycho HAND codes drawn
    // magenta and red.
    const summary = summarizeHoldRoles('kilter', 'p1r13p2r37p3r37p4r40');
    expect(summary).toEqual([
      { role: 'HAND', count: 1, color: '#4DF5FD' },
      { role: 'HAND', count: 2, color: '#FF00FF' },
      { role: 'HAND', count: 1, color: '#FF0000' },
    ]);
  });

  it('counts what a static render shows on a multi-frame climb: the union, last role winning', () => {
    // Frame 1 lights 1 as a start and 2 as a hand; the delta frame re-roles 2 as
    // a finish and adds 3 as a foot. Nothing is turned off, so all three show.
    const summary = summarizeHoldRoles('kilter', 'p1r12p2r13,"p2r14p3r15');
    expect(roleCounts(summary)).toEqual([
      ['STARTING', 1],
      ['FINISH', 1],
      ['FOOT', 1],
    ]);
  });

  it('keeps a hold a later frame turns off, because the static render still shows it', () => {
    // `x2` switches hold 2 off in frame 2, but frame 1 lit it, so the union
    // (and the picture) has it.
    const summary = summarizeHoldRoles('kilter', 'p1r12p2r13,"x2p3r14');
    expect(roleCounts(summary)).toEqual([
      ['STARTING', 1],
      ['HAND', 1],
      ['FINISH', 1],
    ]);
  });

  it('starts an absolute later frame from a dark board, then unions it with the earlier ones', () => {
    // Frame 2 has no `"`: it restates the lit set without hold 1, but frame 1
    // lit hold 1 and the union keeps it. Hold 2 changes role in the absolute
    // frame and the last role wins.
    const summary = summarizeHoldRoles('kilter', 'p1r12p2r13,p2r15p3r14');
    expect(roleCounts(summary)).toEqual([
      ['STARTING', 1],
      ['FINISH', 1],
      ['FOOT', 1],
    ]);
  });

  it('ignores unknown role codes and roles outside the legend', () => {
    expect(summarizeHoldRoles('kilter', 'p1r12p2r999')).toEqual([{ role: 'STARTING', count: 1, color: '#00FF00' }]);
    // MoonBoard 46 is AUX, a marker above the hold rather than a role to climb.
    expect(summarizeHoldRoles('moonboard', 'p1r42p2r46').map(({ role }) => role)).toEqual(['STARTING']);
  });
});
