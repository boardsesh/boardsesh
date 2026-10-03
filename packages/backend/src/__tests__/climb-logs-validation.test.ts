import { describe, expect, it } from 'vite-plus/test';
import { ClimbLogsInputSchema } from '../validation/schemas';

const base = { boardType: 'kilter', climbUuid: 'climb-1' };

describe('ClimbLogsInputSchema', () => {
  it('needs only a board and a climb, and defaults the page size to 20', () => {
    const result = ClimbLogsInputSchema.safeParse(base);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.limit).toBe(20);
    expect(result.data.angle).toBeUndefined();
    expect(result.data.withNotes).toBeUndefined();
    expect(result.data.sendsOnly).toBeUndefined();
    expect(result.data.excludeFollowed).toBeUndefined();
    expect(result.data.latestPerClimber).toBeUndefined();
    expect(result.data.cursor).toBeUndefined();
  });

  it('accepts every filter together', () => {
    const result = ClimbLogsInputSchema.safeParse({
      ...base,
      angle: 40,
      withNotes: true,
      sendsOnly: true,
      excludeFollowed: true,
      latestPerClimber: true,
      limit: 50,
      cursor: 'abc',
    });

    expect(result.success).toBe(true);
  });

  it('accepts null for the optional fields, as a GraphQL client may send them', () => {
    const result = ClimbLogsInputSchema.safeParse({
      ...base,
      angle: null,
      withNotes: null,
      sendsOnly: null,
      excludeFollowed: null,
      latestPerClimber: null,
      cursor: null,
    });

    expect(result.success).toBe(true);
  });

  it.each([1, 20, 50])('accepts a page size of %i', (limit) => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, limit }).success).toBe(true);
  });

  it.each([0, 51, -1, 2.5])('rejects a page size of %s', (limit) => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, limit }).success).toBe(false);
  });

  // An angle no board has is an empty page, never a validation error.
  it.each([-5, 0, 40, 95])('accepts angle %i', (angle) => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, angle }).success).toBe(true);
  });

  it('rejects a fractional angle', () => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, angle: 40.5 }).success).toBe(false);
  });

  it('accepts a spray wall climb', () => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, boardType: 'spray' }).success).toBe(true);
  });

  it('rejects an unknown board type', () => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, boardType: 'woodboard' }).success).toBe(false);
  });

  it('rejects an empty climb uuid and one past 100 characters', () => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, climbUuid: '' }).success).toBe(false);
    expect(ClimbLogsInputSchema.safeParse({ ...base, climbUuid: 'x'.repeat(101) }).success).toBe(false);
  });

  it('rejects a cursor past 512 characters', () => {
    expect(ClimbLogsInputSchema.safeParse({ ...base, cursor: 'x'.repeat(513) }).success).toBe(false);
  });
});
