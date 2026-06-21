import { describe, it, expect } from 'vite-plus/test';
import {
  FollowInputSchema,
  FollowListInputSchema,
  SearchUsersInputSchema,
  FollowingAscentsFeedInputSchema,
  FollowSetterInputSchema,
  SetterProfileInputSchema,
  SetterClimbsInputSchema,
  SetterClimbsFullInputSchema,
  BulkVoteSummaryInputSchema,
} from '../validation/schemas';

describe('Social Validation Schemas', () => {
  describe('FollowInputSchema', () => {
    it('should accept a valid user ID', () => {
      const result = FollowInputSchema.safeParse({ userId: 'user-123' });
      expect(result.success).toBe(true);
    });

    it('should reject an empty user ID', () => {
      const result = FollowInputSchema.safeParse({ userId: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('cannot be empty');
      }
    });

    it('should reject missing userId', () => {
      const result = FollowInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('FollowListInputSchema', () => {
    it('should accept valid input with defaults', () => {
      const result = FollowListInputSchema.safeParse({ userId: 'user-123' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('should accept custom limit and offset', () => {
      const result = FollowListInputSchema.safeParse({
        userId: 'user-123',
        limit: 10,
        offset: 5,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(10);
        expect(result.data.offset).toBe(5);
      }
    });

    it('should reject limit exceeding max (50)', () => {
      const result = FollowListInputSchema.safeParse({
        userId: 'user-123',
        limit: 100,
      });
      expect(result.success).toBe(false);
    });

    it('should reject limit less than 1', () => {
      const result = FollowListInputSchema.safeParse({
        userId: 'user-123',
        limit: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative offset', () => {
      const result = FollowListInputSchema.safeParse({
        userId: 'user-123',
        offset: -1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty userId', () => {
      const result = FollowListInputSchema.safeParse({
        userId: '',
        limit: 10,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('SearchUsersInputSchema', () => {
    it('should accept a valid query', () => {
      const result = SearchUsersInputSchema.safeParse({ query: 'john' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('should reject query shorter than 2 characters', () => {
      const result = SearchUsersInputSchema.safeParse({ query: 'a' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 2 characters');
      }
    });

    it('should reject query longer than 100 characters', () => {
      const result = SearchUsersInputSchema.safeParse({ query: 'a'.repeat(101) });
      expect(result.success).toBe(false);
    });

    it('should accept optional boardType', () => {
      const result = SearchUsersInputSchema.safeParse({
        query: 'john',
        boardType: 'kilter',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.boardType).toBe('kilter');
      }
    });

    it('should accept custom limit and offset', () => {
      const result = SearchUsersInputSchema.safeParse({
        query: 'john',
        limit: 5,
        offset: 10,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(5);
        expect(result.data.offset).toBe(10);
      }
    });

    it('should reject limit exceeding max (50)', () => {
      const result = SearchUsersInputSchema.safeParse({
        query: 'john',
        limit: 51,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FollowingAscentsFeedInputSchema', () => {
    it('should accept empty input with defaults', () => {
      const result = FollowingAscentsFeedInputSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('should accept custom limit and offset', () => {
      const result = FollowingAscentsFeedInputSchema.safeParse({
        limit: 10,
        offset: 20,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(10);
        expect(result.data.offset).toBe(20);
      }
    });

    it('should reject limit exceeding max (50)', () => {
      const result = FollowingAscentsFeedInputSchema.safeParse({
        limit: 100,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative offset', () => {
      const result = FollowingAscentsFeedInputSchema.safeParse({
        offset: -5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FollowSetterInputSchema', () => {
    it('should accept a valid setter username', () => {
      const result = FollowSetterInputSchema.safeParse({ setterUsername: 'climber42' });
      expect(result.success).toBe(true);
    });

    it('should reject an empty setter username', () => {
      const result = FollowSetterInputSchema.safeParse({ setterUsername: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('cannot be empty');
      }
    });

    it('should reject setter username exceeding max length', () => {
      const result = FollowSetterInputSchema.safeParse({ setterUsername: 'a'.repeat(101) });
      expect(result.success).toBe(false);
    });
  });

  describe('SetterProfileInputSchema', () => {
    it('should accept a valid username', () => {
      const result = SetterProfileInputSchema.safeParse({ username: 'climber42' });
      expect(result.success).toBe(true);
    });

    it('should reject an empty username', () => {
      const result = SetterProfileInputSchema.safeParse({ username: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('cannot be empty');
      }
    });
  });

  describe('SetterClimbsInputSchema', () => {
    it('should accept valid input with defaults', () => {
      const result = SetterClimbsInputSchema.safeParse({ username: 'climber42' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sortBy).toBe('popular');
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('should accept custom limit and offset', () => {
      const result = SetterClimbsInputSchema.safeParse({
        username: 'climber42',
        limit: 50,
        offset: 10,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.offset).toBe(10);
      }
    });

    it('should reject limit exceeding max (100)', () => {
      const result = SetterClimbsInputSchema.safeParse({
        username: 'climber42',
        limit: 101,
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid sortBy values', () => {
      const popular = SetterClimbsInputSchema.safeParse({ username: 'x', sortBy: 'popular' });
      const newSort = SetterClimbsInputSchema.safeParse({ username: 'x', sortBy: 'new' });
      expect(popular.success).toBe(true);
      expect(newSort.success).toBe(true);
    });

    it('should reject invalid sortBy values', () => {
      const result = SetterClimbsInputSchema.safeParse({ username: 'x', sortBy: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  describe('SetterClimbsFullInputSchema', () => {
    it('should accept valid input with defaults', () => {
      const result = SetterClimbsFullInputSchema.safeParse({ username: 'climber42' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sortBy).toBe('popular');
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('should accept optional angle, sizeId, and setIds', () => {
      const result = SetterClimbsFullInputSchema.safeParse({
        username: 'climber42',
        angle: 40,
        sizeId: 10,
        setIds: '1,2,3',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.angle).toBe(40);
        expect(result.data.sizeId).toBe(10);
        expect(result.data.setIds).toBe('1,2,3');
      }
    });

    it('should reject limit exceeding max (100)', () => {
      const result = SetterClimbsFullInputSchema.safeParse({
        username: 'climber42',
        limit: 101,
      });
      expect(result.success).toBe(false);
    });

    it('should accept optional boardType', () => {
      const result = SetterClimbsFullInputSchema.safeParse({
        username: 'climber42',
        boardType: 'kilter',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.boardType).toBe('kilter');
      }
    });
  });

  describe('BulkVoteSummaryInputSchema', () => {
    it('should accept a populated entityIds array', () => {
      const result = BulkVoteSummaryInputSchema.safeParse({
        entityType: 'tick',
        entityIds: ['a', 'b'],
      });
      expect(result.success).toBe(true);
    });

    it('should accept an empty entityIds array (no-op, resolver returns [])', () => {
      const result = BulkVoteSummaryInputSchema.safeParse({
        entityType: 'session',
        entityIds: [],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityIds).toEqual([]);
      }
    });

    it('should reject more than 100 entityIds', () => {
      const result = BulkVoteSummaryInputSchema.safeParse({
        entityType: 'tick',
        entityIds: Array.from({ length: 101 }, (_unused, index) => `id-${index}`),
      });
      expect(result.success).toBe(false);
    });
  });
});
