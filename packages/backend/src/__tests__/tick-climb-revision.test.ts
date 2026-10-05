import { describe, expect, it, vi } from 'vite-plus/test';

// The decision is pure, but its module also holds the lookup, which imports the
// database client. Nothing here touches it.
vi.mock('../db/client', () => ({ db: {}, dbRead: {} }));

const { decideTickClimbRevision } = await import('../graphql/resolvers/ticks/tick-climb-revision');
const { SaveTickInputSchema, UpdateTickInputSchema } = await import('../validation/schemas/ticks');

const store = (revision: number | null, clientRevisionAhead = false) => ({
  kind: 'store',
  revision,
  clientRevisionAhead,
});
const byDate = (clientRevisionAhead = false) => ({ kind: 'live-at-climbed-at', clientRevisionAhead });

describe('decideTickClimbRevision', () => {
  it('stores NULL when the climb has no catalogue row, whatever the client sent', () => {
    for (const clientRevision of [undefined, null, 1, 4]) {
      expect(decideTickClimbRevision({ currentRevision: null, clientRevision, aliasRemapped: false })).toEqual(
        store(null),
      );
    }
    expect(decideTickClimbRevision({ currentRevision: null, clientRevision: 2, aliasRemapped: true })).toEqual(
      store(null),
    );
  });

  it('stores the client revision anywhere from 1 up to the current one', () => {
    for (const clientRevision of [1, 2, 3]) {
      expect(decideTickClimbRevision({ currentRevision: 3, clientRevision, aliasRemapped: false })).toEqual(
        store(clientRevision),
      );
    }
    expect(decideTickClimbRevision({ currentRevision: 1, clientRevision: 1, aliasRemapped: false })).toEqual(store(1));
  });

  it('falls back, flagged, when the client is ahead of the climb', () => {
    expect(decideTickClimbRevision({ currentRevision: 3, clientRevision: 4, aliasRemapped: false })).toEqual(
      byDate(true),
    );
    // A never-edited climb has only ever had revision 1, so no lookup is needed.
    expect(decideTickClimbRevision({ currentRevision: 1, clientRevision: 4, aliasRemapped: false })).toEqual(
      store(1, true),
    );
  });

  it('stores 1 for a never-edited climb when nothing was sent', () => {
    for (const clientRevision of [undefined, null]) {
      expect(decideTickClimbRevision({ currentRevision: 1, clientRevision, aliasRemapped: false })).toEqual(store(1));
    }
  });

  it('falls back to the date for an edited climb when nothing was sent', () => {
    for (const clientRevision of [undefined, null]) {
      expect(decideTickClimbRevision({ currentRevision: 5, clientRevision, aliasRemapped: false })).toEqual(byDate());
    }
  });

  it('ignores the client revision across an alias, in range or not, without flagging it', () => {
    for (const clientRevision of [1, 2, 9]) {
      expect(decideTickClimbRevision({ currentRevision: 3, clientRevision, aliasRemapped: true })).toEqual(byDate());
      expect(decideTickClimbRevision({ currentRevision: 1, clientRevision, aliasRemapped: true })).toEqual(store(1));
    }
  });

  it('never stores a value below 1, even if one gets past validation', () => {
    expect(decideTickClimbRevision({ currentRevision: 3, clientRevision: 0, aliasRemapped: false })).toEqual(byDate());
    expect(decideTickClimbRevision({ currentRevision: 1, clientRevision: -2, aliasRemapped: false })).toEqual(store(1));
  });
});

describe('SaveTickInputSchema.climbRevision', () => {
  const tick = {
    boardType: 'kilter',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    isBenchmark: false,
    comment: '',
    climbedAt: '2026-10-01T10:00:00.000Z',
  };

  it('passes a positive integer through, and nothing when nothing was sent', () => {
    expect(SaveTickInputSchema.parse({ ...tick, climbRevision: 3 }).climbRevision).toBe(3);
    expect(SaveTickInputSchema.parse(tick).climbRevision).toBeUndefined();
    expect(SaveTickInputSchema.parse({ ...tick, climbRevision: null }).climbRevision).toBeNull();
  });

  // A rejected send dead-letters in the offline drainer, so no integer may fail
  // the parse. 0 and the negatives are the whole set of bad values the GraphQL
  // `Int` scalar lets through to here; what it does with the rest is pinned
  // through the real schema in save-tick-climb-revision.test.ts.
  it.each([[0], [-1], [-2147483648]])('drops %s instead of failing the tick', (bad) => {
    const parsed = SaveTickInputSchema.safeParse({ ...tick, climbRevision: bad });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.climbRevision).toBeNull();
  });

  it('is not part of an update: updateTick cannot be asked to move it', () => {
    expect(UpdateTickInputSchema.parse({ comment: 'Edited', climbRevision: 9 })).toEqual({ comment: 'Edited' });
  });
});
