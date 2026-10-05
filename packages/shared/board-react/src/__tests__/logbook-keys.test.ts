import { describe, it, expect } from 'vitest';
import {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
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

  it('adds no version key when the source has none', () => {
    expect('climb_revision' in toLogbookEntry(sourceTick)).toBe(false);
    expect('climb_revision' in toLogbookEntry({ ...sourceTick, climbRevision: null })).toBe(false);
  });

  it('joins local versions onto entries by tick uuid', () => {
    const entries = [toLogbookEntry(sourceTick), toLogbookEntry({ ...sourceTick, uuid: 'tick-2' })];
    const joined = withTickRevisions(entries, new Map([['tick-2', 4]]));

    expect(joined[0]).toBe(entries[0]);
    expect(joined[0].climb_revision).toBeUndefined();
    expect(joined[1].climb_revision).toBe(4);
  });

  it('keeps a version the entry already has', () => {
    const entries = [toLogbookEntry({ ...sourceTick, climbRevision: 2 })];
    expect(withTickRevisions(entries, new Map([['tick-1', 9]]))[0].climb_revision).toBe(2);
  });

  it('returns the same array when there is nothing to join', () => {
    const entries = [toLogbookEntry(sourceTick)];
    expect(withTickRevisions(entries, new Map())).toBe(entries);
    expect(withTickRevisions(entries, new Map([['another-tick', 2]]))).toBe(entries);
  });
});
