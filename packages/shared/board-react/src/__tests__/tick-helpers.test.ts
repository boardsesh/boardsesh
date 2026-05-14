import { describe, it, expect } from 'vitest';
import {
  buildOptimisticTickEntry,
  applySavedTickToLogbook,
  rollbackOptimisticTick,
  type SaveTickOptions,
} from '../tick-helpers';
import type { LogbookEntry } from '../logbook-keys';

const baseOptions: SaveTickOptions = {
  climbUuid: 'climb-1',
  angle: 40,
  isMirror: false,
  status: 'send',
  attemptCount: 3,
  isBenchmark: false,
  comment: 'sent it',
  climbedAt: '2026-05-30T00:00:00.000Z',
};

function entry(uuid: string, overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return {
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
    ...overrides,
  };
}

describe('buildOptimisticTickEntry', () => {
  it('builds an entry keyed by the temp uuid with send treated as an ascent', () => {
    const result = buildOptimisticTickEntry(baseOptions, 'temp-123');
    expect(result).toEqual({
      uuid: 'temp-123',
      climb_uuid: 'climb-1',
      angle: 40,
      is_mirror: false,
      tries: 3,
      quality: null,
      difficulty: null,
      effectiveDifficulty: null,
      comment: 'sent it',
      climbed_at: '2026-05-30T00:00:00.000Z',
      is_ascent: true,
      status: 'send',
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    });
  });

  it('coerces undefined quality/difficulty to null and marks attempt as non-ascent', () => {
    const result = buildOptimisticTickEntry(
      { ...baseOptions, status: 'attempt', quality: undefined, difficulty: undefined },
      'temp-9',
    );
    expect(result.quality).toBeNull();
    expect(result.difficulty).toBeNull();
    expect(result.is_ascent).toBe(false);
  });
});

describe('applySavedTickToLogbook', () => {
  it('replaces the optimistic temp entry in place', () => {
    const existing = [entry('temp-1'), entry('other')];
    const saved = entry('real-1');
    const result = applySavedTickToLogbook(existing, saved, 'temp-1');
    expect(result.map((item) => item.uuid)).toEqual(['real-1', 'other']);
  });

  it('de-duplicates when the saved uuid already exists alongside the temp entry', () => {
    // Server echo already merged the real entry before onSuccess replaces temp.
    const existing = [entry('temp-1'), entry('real-1'), entry('other')];
    const result = applySavedTickToLogbook(existing, entry('real-1'), 'temp-1');
    const ids = result.map((item) => item.uuid);
    expect(ids).toEqual(['real-1', 'other']);
    expect(ids.filter((id) => id === 'real-1')).toHaveLength(1);
  });

  it('prepends when there is no temp uuid and the entry is new', () => {
    const existing = [entry('a')];
    const result = applySavedTickToLogbook(existing, entry('b'), undefined);
    expect(result.map((item) => item.uuid)).toEqual(['b', 'a']);
  });

  it('is idempotent when there is no temp uuid and the entry already exists', () => {
    const existing = [entry('a')];
    const result = applySavedTickToLogbook(existing, entry('a'), undefined);
    expect(result).toBe(existing);
  });

  it('prepends when the temp uuid is gone (already reconciled) and entry is new', () => {
    const existing = [entry('a')];
    const result = applySavedTickToLogbook(existing, entry('b'), 'temp-missing');
    expect(result.map((item) => item.uuid)).toEqual(['b', 'a']);
  });
});

describe('rollbackOptimisticTick', () => {
  it('removes only the temp entry', () => {
    const existing = [entry('temp-1'), entry('a')];
    const result = rollbackOptimisticTick(existing, 'temp-1');
    expect(result.map((item) => item.uuid)).toEqual(['a']);
  });

  it('leaves the list untouched when the temp entry is absent', () => {
    const existing = [entry('a'), entry('b')];
    const result = rollbackOptimisticTick(existing, 'temp-x');
    expect(result.map((item) => item.uuid)).toEqual(['a', 'b']);
  });
});
