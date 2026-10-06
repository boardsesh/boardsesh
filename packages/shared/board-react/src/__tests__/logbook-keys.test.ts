import { describe, it, expect } from 'vitest';
import {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  mergeTickRevision,
  withTickRevisions,
  type LogbookEntry,
} from '../logbook-keys';

describe('toLogbookEntry', () => {
  it('maps a source tick to a logbook entry, marking flash as an ascent', () => {
    const entry = toLogbookEntry({
      uuid: 'tick-1',
      climbUuid: 'climb-1',
      angle: 40,
      isMirror: true,
      status: 'flash',
      attemptCount: 1,
      quality: 3,
      difficulty: 12,
      comment: 'nice',
      climbedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(entry).toEqual({
      uuid: 'tick-1',
      climb_uuid: 'climb-1',
      angle: 40,
      is_mirror: true,
      tries: 1,
      quality: 3,
      // No synced rating on the source tick → falls back to the tick's own quality.
      effectiveQuality: 3,
      difficulty: 12,
      comment: 'nice',
      climbed_at: '2026-05-30T00:00:00.000Z',
      is_ascent: true,
      status: 'flash',
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    });
  });

  it('treats attempt as a non-ascent and defaults nullable fields', () => {
    const entry = toLogbookEntry({
      uuid: 'tick-2',
      climbUuid: 'climb-2',
      angle: 25,
      isMirror: false,
      status: 'attempt',
      attemptCount: 5,
      quality: null,
      difficulty: null,
      comment: '',
      climbedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(entry.is_ascent).toBe(false);
    expect(entry.quality).toBeNull();
    expect(entry.difficulty).toBeNull();
    expect(entry.upvotes).toBe(0);
    expect(entry.downvotes).toBe(0);
    expect(entry.commentCount).toBe(0);
  });

  it('preserves provided vote and comment counts', () => {
    const entry = toLogbookEntry({
      uuid: 'tick-3',
      climbUuid: 'climb-3',
      angle: 30,
      isMirror: false,
      status: 'send',
      attemptCount: 3,
      quality: 2,
      difficulty: 10,
      comment: 'sent',
      climbedAt: '2026-05-30T00:00:00.000Z',
      upvotes: 4,
      downvotes: 1,
      commentCount: 2,
    });

    expect(entry.is_ascent).toBe(true);
    expect(entry.upvotes).toBe(4);
    expect(entry.downvotes).toBe(1);
    expect(entry.commentCount).toBe(2);
  });
});

describe('mergeLogbookEntries', () => {
  const make = (uuid: string): LogbookEntry => ({
    uuid,
    climb_uuid: `climb-${uuid}`,
    angle: 40,
    is_mirror: false,
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    climbed_at: '2026-05-30T00:00:00.000Z',
    is_ascent: true,
    status: 'send',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
  });

  it('returns the existing array unchanged when there is nothing to merge', () => {
    const existing = [make('a')];
    expect(mergeLogbookEntries(existing, [])).toBe(existing);
  });

  it('appends only entries whose uuid is not already present', () => {
    const existing = [make('a'), make('b')];
    const merged = mergeLogbookEntries(existing, [make('b'), make('c')]);
    expect(merged.map((entry) => entry.uuid)).toEqual(['a', 'b', 'c']);
  });

  it('returns the existing reference when every incoming entry is a duplicate', () => {
    const existing = [make('a')];
    expect(mergeLogbookEntries(existing, [make('a')])).toBe(existing);
  });
});

describe('logbook query keys', () => {
  it('builds a stable accumulated key per board', () => {
    expect(accumulatedLogbookQueryKey('kilter')).toEqual(['logbook', 'kilter', 'accumulated']);
  });

  it('builds a fetch prefix per board', () => {
    expect(fetchLogbookQueryKeyPrefix('tension')).toEqual(['logbook', 'tension', 'fetch']);
  });

  it('produces distinct, inert keys for a null (unresolved) board', () => {
    expect(accumulatedLogbookQueryKey(null)).toEqual(['logbook', null, 'accumulated']);
    expect(fetchLogbookQueryKeyPrefix(null)).toEqual(['logbook', null, 'fetch']);
  });
});

describe('climb version on a logbook entry (#6023)', () => {
  const sourceTick = {
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send' as const,
    attemptCount: 2,
    quality: null,
    difficulty: null,
    comment: '',
    climbedAt: '2026-10-01T10:00:00.000Z',
  };

  it('carries a known version from the source tick', () => {
    expect(toLogbookEntry({ ...sourceTick, climbRevision: 3 }).climb_revision).toBe(3);
  });

  it('adds no version key when the source did not look', () => {
    expect('climb_revision' in toLogbookEntry(sourceTick)).toBe(false);
  });

  it('keeps null, which says the source looked and the tick has no version', () => {
    expect(toLogbookEntry({ ...sourceTick, climbRevision: null }).climb_revision).toBeNull();
  });

  it('joins local versions onto entries by tick uuid', () => {
    const entries = [toLogbookEntry(sourceTick), toLogbookEntry({ ...sourceTick, uuid: 'tick-2' })];
    const joined = withTickRevisions(entries, new Map([['tick-2', 4]]));

    expect(joined[0]).toBe(entries[0]);
    expect(joined[0].climb_revision).toBeUndefined();
    expect(joined[1].climb_revision).toBe(4);
  });

  it('keeps the three local answers apart: a number, a row with none, and no row', () => {
    const entries = ['with-version', 'row-without', 'no-row'].map((uuid) => toLogbookEntry({ ...sourceTick, uuid }));
    const joined = withTickRevisions(
      entries,
      new Map<string, number | null>([
        ['with-version', 3],
        ['row-without', null],
      ]),
    );

    expect(joined[0].climb_revision).toBe(3);
    expect(joined[1].climb_revision).toBeNull();
    expect('climb_revision' in joined[2]).toBe(false);
  });

  it('never trades what an entry knows for less', () => {
    const known = [toLogbookEntry({ ...sourceTick, climbRevision: 2 })];
    expect(withTickRevisions(known, new Map<string, number | null>([['tick-1', null]]))).toBe(known);
    // A later number is the server's own answer, pulled since. It wins.
    expect(withTickRevisions(known, new Map([['tick-1', 4]]))[0].climb_revision).toBe(4);
  });

  it.each([
    [undefined, 3, 3],
    [null, 3, 3],
    [2, 3, 3],
    [undefined, null, null],
    [2, null, 2],
    [2, undefined, 2],
    [null, undefined, null],
    [undefined, undefined, undefined],
  ])('mergeTickRevision(%s, %s) is %s', (existing, incoming, expected) => {
    expect(mergeTickRevision(existing, incoming)).toBe(expected);
  });

  it('returns the same array when there is nothing to join', () => {
    const entries = [toLogbookEntry(sourceTick)];
    expect(withTickRevisions(entries, new Map())).toBe(entries);
    expect(withTickRevisions(entries, new Map([['another-tick', 2]]))).toBe(entries);
  });
});

// #6023: a row that is already in the accumulated logbook must not keep "version
// not known" for the rest of the session once a later read has the answer.
describe('mergeLogbookEntries: upgrading the climb version of a cached row', () => {
  const cached = (uuid: string, climbRevision?: number | null): LogbookEntry =>
    toLogbookEntry({
      uuid,
      climbUuid: 'climb-1',
      angle: 40,
      isMirror: false,
      status: 'send',
      attemptCount: 1,
      quality: null,
      difficulty: null,
      comment: '',
      climbedAt: '2026-10-01T10:00:00.000Z',
      ...(climbRevision === undefined ? {} : { climbRevision }),
    });

  it('gives a cached row the version a later read has, and keeps everything else about it', () => {
    const existing = [{ ...cached('tick-1'), comment: 'edited locally' }, cached('tick-2')];
    const merged = mergeLogbookEntries(existing, [cached('tick-1', 2)]);

    expect(merged).not.toBe(existing);
    expect(merged[0]).toEqual({ ...existing[0], climb_revision: 2 });
    expect(merged[1]).toBe(existing[1]);
    expect(merged).toHaveLength(2);
  });

  it('upgrades "not known" to "known to have none"', () => {
    const merged = mergeLogbookEntries([cached('tick-1')], [cached('tick-1', null)]);
    expect(merged[0].climb_revision).toBeNull();
  });

  it('does not downgrade a known version when a later read knows less', () => {
    const existing = [cached('tick-1', 3)];
    expect(mergeLogbookEntries(existing, [cached('tick-1')])).toBe(existing);
    expect(mergeLogbookEntries(existing, [cached('tick-1', null)])).toBe(existing);
  });

  it('upgrades and appends in one pass', () => {
    const merged = mergeLogbookEntries([cached('tick-1')], [cached('tick-1', 2), cached('tick-9', 1)]);
    expect(merged.map((entry) => [entry.uuid, entry.climb_revision])).toEqual([
      ['tick-1', 2],
      ['tick-9', 1],
    ]);
  });

  it('keeps the existing reference when a duplicate brings nothing new', () => {
    const existing = [cached('tick-1', 2)];
    expect(mergeLogbookEntries(existing, [cached('tick-1', 2)])).toBe(existing);
  });
});
