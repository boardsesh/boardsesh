import { describe, expect, it, vi } from 'vite-plus/test';

// The diff is pure, but its module also holds the write path, which imports the
// database client. Nothing here touches it.
vi.mock('../db/client', () => ({ db: {}, dbRead: {} }));

const { diffClimbRevisionStates, holdsMoved } = await import('../graphql/resolvers/climbs/climb-revisions');
type ClimbRevisionState = import('../graphql/resolvers/climbs/climb-revisions').ClimbRevisionState;

const published = (overrides: Partial<ClimbRevisionState> = {}): ClimbRevisionState => ({
  userId: 'setter',
  isDraft: false,
  publishedAt: '2026-09-01T10:00:00.000Z',
  createdAt: '2026-09-01T09:00:00.000Z',
  name: 'Original',
  description: 'Notes',
  frames: 'p1r1p2r3',
  framesCount: 1,
  framesPace: 0,
  angle: 40,
  characteristics: null,
  difficultyId: 18,
  revisionNumber: 1,
  holdsRevisionNumber: 1,
  ...overrides,
});

describe('diffClimbRevisionStates', () => {
  it('reports nothing for two identical states', () => {
    expect(diffClimbRevisionStates('spray', published(), published())).toEqual([]);
  });

  it('names each field that changed, in a fixed order', () => {
    expect(
      diffClimbRevisionStates(
        'spray',
        published(),
        published({
          name: 'Renamed',
          description: 'New notes',
          frames: 'p1r1p3r3',
          angle: 45,
          difficultyId: 22,
          characteristics: ['any_feet'],
        }),
      ),
    ).toEqual(['name', 'description', 'holds', 'grade', 'angle', 'rules']);
  });

  it('treats a null and an empty value as the same thing', () => {
    expect(
      diffClimbRevisionStates(
        'spray',
        published({ name: null, description: null, framesCount: null, framesPace: null }),
        published({ name: '', description: '', framesCount: 1, framesPace: 0 }),
      ),
    ).toEqual([]);
    // No stored rules and an explicitly empty rule set are both "no rules".
    expect(
      diffClimbRevisionStates('spray', published({ characteristics: null }), published({ characteristics: [] })),
    ).toEqual([]);
  });

  it('counts a frame count or pace change under holds', () => {
    expect(diffClimbRevisionStates('kilter', published(), published({ framesCount: 2 }))).toEqual(['holds']);
    expect(diffClimbRevisionStates('kilter', published(), published({ framesPace: 400 }))).toEqual(['holds']);
  });

  it('ignores rule order and duplicates', () => {
    expect(
      diffClimbRevisionStates(
        'kilter',
        published({ characteristics: ['no_match', 'campus'] }),
        published({ characteristics: ['campus', 'no_match', 'campus'] }),
      ),
    ).toEqual([]);
  });

  it('reads the Aurora "No match" description prefix as a rule, not as prose', () => {
    // The first edit after the legacy prefix: the description loses the marker
    // and the array gains the token. Neither is something the editor changed.
    expect(
      diffClimbRevisionStates(
        'kilter',
        published({ description: 'No match\nSit start', characteristics: null }),
        published({ description: 'Sit start', characteristics: ['no_match'] }),
      ),
    ).toEqual([]);

    // Turning the rule on through the prefix is a rule change and nothing else.
    expect(
      diffClimbRevisionStates(
        'kilter',
        published({ description: 'Sit start', characteristics: null }),
        published({ description: 'No match\nSit start', characteristics: null }),
      ),
    ).toEqual(['rules']);
  });

  it('keeps "No match" as prose on a board with no such prefix', () => {
    expect(
      diffClimbRevisionStates(
        'spray',
        published({ description: 'Sit start', characteristics: null }),
        published({ description: 'No match\nSit start', characteristics: null }),
      ),
    ).toEqual(['description']);
  });
});

describe('holdsMoved', () => {
  it('is false for two identical states', () => {
    expect(holdsMoved('spray', published(), published())).toBe(false);
  });

  it('is true when a hold is added, removed or swapped, or the frame count differs', () => {
    expect(holdsMoved('spray', published(), published({ frames: 'p1r1p3r3' }))).toBe(true);
    expect(holdsMoved('spray', published(), published({ frames: 'p1r1p2r3p3r2' }))).toBe(true);
    expect(holdsMoved('spray', published(), published({ frames: 'p1r1' }))).toBe(true);
    expect(holdsMoved('spray', published(), published({ framesCount: 2 }))).toBe(true);
  });

  it('is false for the same holds listed in a different order', () => {
    // The app re-encodes frames in ascending hold-id order on every save. A
    // stored string from another encoder must not read as a hold change, or a
    // rename would restart the climb's sends.
    expect(holdsMoved('spray', published({ frames: 'p2r3p1r1' }), published({ frames: 'p1r1p2r3' }))).toBe(false);
    expect(
      holdsMoved(
        'kilter',
        published({ frames: 'p1140r15p1117r12p1200r13' }),
        published({ frames: 'p1117r12p1140r15p1200r13' }),
      ),
    ).toBe(false);
    // And so the diff records no edit for it either.
    expect(
      diffClimbRevisionStates('spray', published({ frames: 'p2r3p1r1' }), published({ frames: 'p1r1p2r3' })),
    ).toEqual([]);
  });

  it('is true when only a role changes', () => {
    expect(holdsMoved('spray', published(), published({ frames: 'p1r1p2r2' }))).toBe(true);
    expect(diffClimbRevisionStates('spray', published(), published({ frames: 'p1r1p2r2' }))).toEqual(['holds']);
  });

  it('compares a multi-frame climb frame by frame', () => {
    const route = published({ frames: 'p1117r12p1140r15,p1200r13', framesCount: 2 });
    // The same holds, reordered inside each frame.
    expect(holdsMoved('kilter', route, published({ frames: 'p1140r15p1117r12,p1200r13', framesCount: 2 }))).toBe(false);
    // A hold that moves to the other frame is a different route.
    expect(holdsMoved('kilter', route, published({ frames: 'p1117r12,p1140r15p1200r13', framesCount: 2 }))).toBe(true);
    // So is a hold added to one frame.
    expect(
      holdsMoved('kilter', route, published({ frames: 'p1117r12p1140r15,p1200r13p1201r13', framesCount: 2 })),
    ).toBe(true);
  });

  it('is false for a pace-only edit, which the diff still reports under `holds`', () => {
    const slower = published({ framesPace: 900 });
    expect(diffClimbRevisionStates('kilter', published(), slower)).toEqual(['holds']);
    expect(holdsMoved('kilter', published(), slower)).toBe(false);
  });

  it('is false for every edit that leaves the holds where they were', () => {
    expect(
      holdsMoved(
        'spray',
        published(),
        published({
          name: 'Renamed',
          description: 'New notes',
          angle: 45,
          difficultyId: 22,
          characteristics: ['any_feet'],
        }),
      ),
    ).toBe(false);
  });

  it('treats a missing frame count as 1 and missing frames as empty', () => {
    expect(holdsMoved('spray', published({ framesCount: null }), published({ framesCount: 1 }))).toBe(false);
    expect(holdsMoved('spray', published({ frames: null }), published({ frames: '' }))).toBe(false);
  });
});
