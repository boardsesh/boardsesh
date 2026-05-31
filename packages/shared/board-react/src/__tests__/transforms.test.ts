import { describe, it, expect } from 'vitest';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  fetchLogbookQueryKey,
  logbookQueryKey,
  nextTempUuid,
  buildOptimisticTickEntry,
  applySavedTickToLogbook,
  rollbackOptimisticTick,
  toSaveClimbInput,
  isDuplicateClimbError,
  type LogbookEntry,
  type SaveTickOptions,
  type SaveClimbOptions,
} from '../transforms';

describe('toLogbookEntry', () => {
  it('maps a source tick and marks flash/send as an ascent', () => {
    expect(
      toLogbookEntry({
        uuid: 't1',
        climbUuid: 'c1',
        angle: 40,
        isMirror: true,
        status: 'flash',
        attemptCount: 1,
        quality: 3,
        difficulty: 12,
        comment: 'nice',
        climbedAt: '2026-01-01',
      }),
    ).toEqual({
      uuid: 't1',
      climb_uuid: 'c1',
      angle: 40,
      is_mirror: true,
      tries: 1,
      quality: 3,
      difficulty: 12,
      comment: 'nice',
      climbed_at: '2026-01-01',
      is_ascent: true,
      status: 'flash',
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    });
  });

  it('treats attempt as non-ascent and defaults nullable vote/comment counts', () => {
    const entry = toLogbookEntry({
      uuid: 't2',
      climbUuid: 'c2',
      angle: 25,
      isMirror: false,
      status: 'attempt',
      attemptCount: 5,
      quality: null,
      difficulty: null,
      comment: '',
      climbedAt: '2026-01-01',
    });
    expect(entry.is_ascent).toBe(false);
    expect(entry.upvotes).toBe(0);
    expect(entry.downvotes).toBe(0);
    expect(entry.commentCount).toBe(0);
  });

  it('preserves provided vote/comment counts', () => {
    const entry = toLogbookEntry({
      uuid: 't3',
      climbUuid: 'c3',
      angle: 30,
      isMirror: false,
      status: 'send',
      attemptCount: 2,
      quality: 2,
      difficulty: 10,
      comment: 'sent',
      climbedAt: '2026-01-01',
      upvotes: 4,
      downvotes: 1,
      commentCount: 2,
    });
    expect(entry).toMatchObject({ is_ascent: true, upvotes: 4, downvotes: 1, commentCount: 2 });
  });
});

const entry = (uuid: string, overrides: Partial<LogbookEntry> = {}): LogbookEntry => ({
  uuid,
  climb_uuid: `c-${uuid}`,
  angle: 40,
  is_mirror: false,
  tries: 1,
  quality: null,
  difficulty: null,
  comment: '',
  climbed_at: '2026-01-01',
  is_ascent: true,
  status: 'send',
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  ...overrides,
});

describe('mergeLogbookEntries', () => {
  it('returns the existing reference when nothing to merge', () => {
    const existing = [entry('a')];
    expect(mergeLogbookEntries(existing, [])).toBe(existing);
    expect(mergeLogbookEntries(existing, [entry('a')])).toBe(existing);
  });

  it('appends only entries whose uuid is not already present', () => {
    const merged = mergeLogbookEntries([entry('a'), entry('b')], [entry('b'), entry('c')]);
    expect(merged.map((item) => item.uuid)).toEqual(['a', 'b', 'c']);
  });
});

describe('query key builders', () => {
  it('builds per-board accumulated + fetch keys', () => {
    expect(accumulatedLogbookQueryKey('kilter')).toEqual(['logbook', 'kilter', 'accumulated']);
    expect(fetchLogbookQueryKeyPrefix('tension')).toEqual(['logbook', 'tension', 'fetch']);
    expect(fetchLogbookQueryKey('kilter', ['c', 'a', 'b'])).toEqual(['logbook', 'kilter', 'fetch', 'a,b,c']);
  });

  it('sorts uuids so logbookQueryKey is order-independent (web contract)', () => {
    expect(logbookQueryKey('kilter', ['a', 'b'])).toEqual(['logbook', 'kilter', 'a,b']);
    expect(logbookQueryKey('kilter', ['b', 'a'])).toEqual(['logbook', 'kilter', 'a,b']);
  });

  it('yields distinct, inert keys for a null (unresolved) board', () => {
    expect(accumulatedLogbookQueryKey(null)).toEqual(['logbook', null, 'accumulated']);
    expect(fetchLogbookQueryKeyPrefix(null)).toEqual(['logbook', null, 'fetch']);
  });
});

describe('nextTempUuid', () => {
  it('produces unique temp ids even within the same millisecond', () => {
    const a = nextTempUuid();
    const b = nextTempUuid();
    expect(a).not.toBe(b);
    expect(a.startsWith('temp-')).toBe(true);
    expect(b.startsWith('temp-')).toBe(true);
  });
});

const baseTick: SaveTickOptions = {
  climbUuid: 'c1',
  angle: 40,
  isMirror: false,
  status: 'send',
  attemptCount: 3,
  isBenchmark: false,
  comment: 'sent it',
  climbedAt: '2026-01-01',
};

describe('buildOptimisticTickEntry', () => {
  it('keys by the temp uuid and treats send as an ascent', () => {
    const result = buildOptimisticTickEntry(baseTick, 'temp-x');
    expect(result).toMatchObject({ uuid: 'temp-x', climb_uuid: 'c1', tries: 3, is_ascent: true, status: 'send' });
  });

  it('coerces undefined quality/difficulty to null and attempt to non-ascent', () => {
    const result = buildOptimisticTickEntry(
      { ...baseTick, status: 'attempt', quality: undefined, difficulty: undefined },
      'temp-y',
    );
    expect(result.quality).toBeNull();
    expect(result.difficulty).toBeNull();
    expect(result.is_ascent).toBe(false);
  });
});

describe('applySavedTickToLogbook', () => {
  it('replaces the optimistic temp entry in place', () => {
    const result = applySavedTickToLogbook([entry('temp-1'), entry('other')], entry('real-1'), 'temp-1');
    expect(result.map((item) => item.uuid)).toEqual(['real-1', 'other']);
  });

  it('de-duplicates when the saved uuid already exists alongside the temp entry', () => {
    const result = applySavedTickToLogbook(
      [entry('temp-1'), entry('real-1'), entry('other')],
      entry('real-1'),
      'temp-1',
    );
    const ids = result.map((item) => item.uuid);
    expect(ids).toEqual(['real-1', 'other']);
    expect(ids.filter((id) => id === 'real-1')).toHaveLength(1);
  });

  it('prepends when there is no temp uuid and the entry is new', () => {
    expect(applySavedTickToLogbook([entry('a')], entry('b'), undefined).map((i) => i.uuid)).toEqual(['b', 'a']);
  });

  it('is idempotent when there is no temp uuid and the entry exists', () => {
    const existing = [entry('a')];
    expect(applySavedTickToLogbook(existing, entry('a'), undefined)).toBe(existing);
  });

  it('prepends when the temp uuid is already gone and the entry is new', () => {
    expect(applySavedTickToLogbook([entry('a')], entry('b'), 'temp-missing').map((i) => i.uuid)).toEqual(['b', 'a']);
  });
});

describe('rollbackOptimisticTick', () => {
  it('removes only the temp entry', () => {
    expect(rollbackOptimisticTick([entry('temp-1'), entry('a')], 'temp-1').map((i) => i.uuid)).toEqual(['a']);
  });

  it('leaves the list untouched when the temp entry is absent', () => {
    expect(rollbackOptimisticTick([entry('a'), entry('b')], 'temp-x').map((i) => i.uuid)).toEqual(['a', 'b']);
  });
});

describe('toSaveClimbInput', () => {
  const options: SaveClimbOptions = {
    layout_id: 8,
    name: 'Test',
    description: 'desc',
    is_draft: true,
    frames: 'p1234r12',
    frames_count: 1,
    frames_pace: 0,
    angle: 40,
  };

  it('maps snake_case to camelCase GraphQL input', () => {
    expect(toSaveClimbInput('kilter', options)).toEqual({
      boardType: 'kilter',
      layoutId: 8,
      name: 'Test',
      description: 'desc',
      isDraft: true,
      frames: 'p1234r12',
      framesCount: 1,
      framesPace: 0,
      angle: 40,
    });
  });

  it('defaults a missing description to empty string', () => {
    expect(toSaveClimbInput('tension', { ...options, description: '' }).description).toBe('');
  });
});

describe('isDuplicateClimbError', () => {
  it('is true for a GraphQLOperationError carrying CLIMB_IS_DUPLICATE', () => {
    const err = new GraphQLOperationError([
      { message: 'dup', extensions: { code: 'CLIMB_IS_DUPLICATE', existingClimbUuid: 'abc' } },
    ]);
    expect(isDuplicateClimbError(err)).toBe(true);
  });

  it('is false for a different code, a plain Error, and non-errors', () => {
    expect(isDuplicateClimbError(new GraphQLOperationError([{ message: 'x', extensions: { code: 'OTHER' } }]))).toBe(
      false,
    );
    expect(isDuplicateClimbError(new Error('CLIMB_IS_DUPLICATE'))).toBe(false);
    expect(isDuplicateClimbError(null)).toBe(false);
    expect(isDuplicateClimbError('CLIMB_IS_DUPLICATE')).toBe(false);
  });
});
