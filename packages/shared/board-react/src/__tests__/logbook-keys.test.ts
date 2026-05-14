import { describe, it, expect } from 'vitest';
import {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
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
      difficulty: 12,
      // No `effectiveDifficulty` on the source tick → falls back to the raw override.
      effectiveDifficulty: 12,
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

  it('keeps a server-provided effectiveDifficulty when the user override is null', () => {
    // `userTicks` (profile/`/you`) supplies `effectiveDifficulty` from the
    // climb's consensus grade even when the user logged no personal override.
    const entry = toLogbookEntry({
      uuid: 'tick-consensus',
      climbUuid: 'climb-consensus',
      angle: 40,
      isMirror: false,
      status: 'send',
      attemptCount: 1,
      quality: null,
      difficulty: null,
      effectiveDifficulty: 7,
      comment: '',
      climbedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(entry.difficulty).toBeNull();
    expect(entry.effectiveDifficulty).toBe(7);
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
    effectiveDifficulty: null,
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
