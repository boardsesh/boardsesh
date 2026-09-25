import { describe, it, expect } from 'vite-plus/test';
import { parseFramesToHoldRows } from '../hold-states';

// Kilter Original role codes: 12 STARTING, 13 HAND, 14 FINISH, 15 FOOT.
describe('parseFramesToHoldRows', () => {
  it('returns no rows for empty or missing frames', () => {
    expect(parseFramesToHoldRows('kilter', '')).toEqual([]);
    expect(parseFramesToHoldRows('kilter', null)).toEqual([]);
    expect(parseFramesToHoldRows('kilter', undefined)).toEqual([]);
  });

  it('maps a single frame to one row per hold with its canonical role', () => {
    expect(parseFramesToHoldRows('kilter', 'p1r12p2r13p3r15p4r14')).toEqual([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 2, holdState: 'HAND' },
      { holdId: 3, holdState: 'FOOT' },
      { holdId: 4, holdState: 'FINISH' },
    ]);
  });

  it('keeps the first role a hold had when a later frame changes it (ON CONFLICT DO NOTHING)', () => {
    const rows = parseFramesToHoldRows('kilter', 'p1r12p2r13,"p2r14p5r15');
    expect(rows).toEqual([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 2, holdState: 'HAND' },
      { holdId: 5, holdState: 'FOOT' },
    ]);
  });

  it('keeps the row of a hold a later frame turns off with x<id>', () => {
    const rows = parseFramesToHoldRows('kilter', 'p1r12p2r13,"x2p3r14');
    expect(rows).toEqual([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 2, holdState: 'HAND' },
      { holdId: 3, holdState: 'FINISH' },
    ]);
  });

  it('drops a role code the board does not know instead of inventing a state', () => {
    const rows = parseFramesToHoldRows('kilter', 'p1r12p2r99');
    expect(rows).toEqual([{ holdId: 1, holdState: 'STARTING' }]);
  });

  it('emits one row per hold even when a single frame repeats it', () => {
    // Within one frame the decoder keeps the LAST token for a hold; across
    // frames the rows keep the FIRST. Either way a hold gets exactly one row.
    const rows = parseFramesToHoldRows('kilter', 'p1r12p1r13');
    expect(rows).toHaveLength(1);
    expect(rows[0].holdId).toBe(1);
  });

  it('reads MoonBoard role codes through the same table', () => {
    const rows = parseFramesToHoldRows('moonboard', 'p1r42p2r43p3r44');
    expect(rows.map((row) => row.holdId)).toEqual([1, 2, 3]);
    for (const row of rows) expect(row.holdState).not.toContain('=');
  });
});
