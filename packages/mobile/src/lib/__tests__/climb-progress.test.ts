import { describe, it, expect } from 'vitest';
import {
  climbProgressTokenBudget,
  deriveClimbProgress,
  describeClimbProgressRecency,
  type ClimbProgressEntry,
} from '../climb-progress';

// The real parser lives in @boardsesh/profile-stats (naive-UTC aware); these
// fixtures already carry a Z, so Date.parse is an exact stand-in here.
const parseMs = (climbedAt: string) => Date.parse(climbedAt);

const tick = (overrides: Partial<ClimbProgressEntry> = {}): ClimbProgressEntry => ({
  is_mirror: false,
  tries: 1,
  climbed_at: '2026-09-01T12:00:00Z',
  status: 'send',
  is_ascent: true,
  ...overrides,
});

describe('deriveClimbProgress', () => {
  it('returns null for a climb with no history (the majority row)', () => {
    expect(deriveClimbProgress(undefined, parseMs)).toBeNull();
    expect(deriveClimbProgress([], parseMs)).toBeNull();
  });

  it('reads a single flash as flashed', () => {
    const progress = deriveClimbProgress([tick({ status: 'flash' })], parseMs);
    expect(progress?.status).toBe('flash');
    expect(progress?.outcome).toEqual({ kind: 'flash' });
  });

  it('counts repeat sends', () => {
    const progress = deriveClimbProgress([tick(), tick({ climbed_at: '2026-09-03T12:00:00Z' })], parseMs);
    expect(progress?.outcome).toEqual({ kind: 'send', sendCount: 2 });
  });

  it('sums tries across attempts when nothing is topped yet', () => {
    const progress = deriveClimbProgress(
      [
        tick({ status: 'attempt', is_ascent: false, tries: 4 }),
        tick({ status: 'attempt', is_ascent: false, tries: 3, climbed_at: '2026-09-02T12:00:00Z' }),
      ],
      parseMs,
    );
    expect(progress?.status).toBe('attempt');
    expect(progress?.outcome).toEqual({ kind: 'attempt', tries: 7 });
  });

  it('counts a tick with no try count as one go', () => {
    const progress = deriveClimbProgress([tick({ status: 'attempt', is_ascent: false, tries: null })], parseMs);
    expect(progress?.outcome).toEqual({ kind: 'attempt', tries: 1 });
  });

  it('prefers a flash over a later plain send for the glyph', () => {
    const progress = deriveClimbProgress(
      [tick({ status: 'send' }), tick({ status: 'flash', climbed_at: '2026-09-05T12:00:00Z' })],
      parseMs,
    );
    expect(progress?.status).toBe('flash');
  });
});

describe('deriveClimbProgress mirror state (#4801)', () => {
  it('reports original-only, which the line then omits', () => {
    expect(deriveClimbProgress([tick({ is_mirror: false })], parseMs)?.mirror).toBe('original');
  });

  it('reports mirror when every send is mirrored', () => {
    expect(deriveClimbProgress([tick({ is_mirror: true })], parseMs)?.mirror).toBe('mirror');
  });

  it('reports both when the two orientations are both sent', () => {
    const progress = deriveClimbProgress(
      [tick({ is_mirror: true }), tick({ is_mirror: false, climbed_at: '2026-09-04T12:00:00Z' })],
      parseMs,
    );
    expect(progress?.mirror).toBe('both');
  });

  it('ignores a mirrored ATTEMPT once the original is sent', () => {
    const progress = deriveClimbProgress(
      [tick({ is_mirror: false }), tick({ is_mirror: true, status: 'attempt', is_ascent: false, tries: 2 })],
      parseMs,
    );
    expect(progress?.mirror).toBe('original');
  });

  it('falls back to the attempts when nothing is sent', () => {
    const progress = deriveClimbProgress(
      [tick({ is_mirror: true, status: 'attempt', is_ascent: false, tries: 2 })],
      parseMs,
    );
    expect(progress?.mirror).toBe('mirror');
  });
});

describe('deriveClimbProgress recency', () => {
  it('keeps the most recent tick', () => {
    const progress = deriveClimbProgress(
      [tick({ climbed_at: '2026-09-01T12:00:00Z' }), tick({ climbed_at: '2026-09-04T09:00:00Z' })],
      parseMs,
    );
    expect(progress?.latestClimbedAtMs).toBe(Date.parse('2026-09-04T09:00:00Z'));
  });

  it('survives ticks with no timestamp', () => {
    const progress = deriveClimbProgress([tick({ climbed_at: null })], parseMs);
    expect(progress?.latestClimbedAtMs).toBeNull();
  });
});

describe('describeClimbProgressRecency', () => {
  const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
    new Date(year, month - 1, day, hour, minute).getTime();

  it('calls the same local day today, even at 23:00', () => {
    expect(describeClimbProgressRecency(at(2026, 9, 6, 23), at(2026, 9, 6, 23, 59))).toEqual({ kind: 'today' });
  });

  it('counts whole local days, never a 0d', () => {
    expect(describeClimbProgressRecency(at(2026, 9, 5, 23), at(2026, 9, 6, 1))).toEqual({ kind: 'days', count: 1 });
    expect(describeClimbProgressRecency(at(2026, 9, 3), at(2026, 9, 6))).toEqual({ kind: 'days', count: 3 });
  });

  it('switches to a date once a week has passed', () => {
    const ms = at(2026, 8, 12);
    expect(describeClimbProgressRecency(ms, at(2026, 9, 6))).toEqual({ kind: 'date', ms });
  });

  it('clamps a future tick (clock skew) to today', () => {
    expect(describeClimbProgressRecency(at(2026, 9, 8), at(2026, 9, 6))).toEqual({ kind: 'today' });
  });
});

describe('climbProgressTokenBudget', () => {
  it('shows all three tokens at the default text size', () => {
    expect(climbProgressTokenBudget(1)).toBe(3);
    expect(climbProgressTokenBudget(1.14)).toBe(3);
  });

  it('drops recency first, then mirror, as Dynamic Type grows', () => {
    expect(climbProgressTokenBudget(1.15)).toBe(2);
    expect(climbProgressTokenBudget(1.29)).toBe(2);
    expect(climbProgressTokenBudget(1.3)).toBe(1);
    expect(climbProgressTokenBudget(1.5)).toBe(1);
  });

  it('falls back to the full line for a nonsense scale', () => {
    expect(climbProgressTokenBudget(Number.NaN)).toBe(3);
  });
});
