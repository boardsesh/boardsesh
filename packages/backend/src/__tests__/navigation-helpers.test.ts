import { describe, it, expect } from 'vite-plus/test';
import {
  buildNavigationItem,
  buildNavigationContext,
  findClimbIndex,
} from '../graphql/resolvers/controller/navigation-helpers';
import type { ClimbQueueItem, Climb } from '@boardsesh/shared-schema';

// Helper to create a mock climb
function createMockClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-uuid-1',
    name: 'Test Climb',
    difficulty: '6a/V3',
    angle: 40,
    ascensionist_count: 10,
    quality_average: '3.5',
    stars: 3.5,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    description: 'A test climb',
    setter_username: 'test_setter',
    frames: 'test-frames',
    ...overrides,
  };
}

// Helper to create a mock queue item
function createMockQueueItem(overrides: Partial<ClimbQueueItem> = {}): ClimbQueueItem {
  return {
    uuid: `queue-item-${Date.now()}-${Math.random()}`,
    climb: createMockClimb(),
    suggested: false,
    ...overrides,
  };
}

describe('Navigation Helper Utilities', () => {
  describe('buildNavigationItem', () => {
    it('should build navigation item with name, grade, and gradeColor', () => {
      const queueItem = createMockQueueItem({
        climb: createMockClimb({
          name: 'Boulder Problem',
          difficulty: 'V5',
        }),
      });

      const result = buildNavigationItem(queueItem);

      expect(result.name).toBe('Boulder Problem');
      expect(result.grade).toBe('V5');
      expect(result.gradeColor).toBe('#F03E3E'); // V5 color
    });

    it('should use getGradeColor for mixed grade formats', () => {
      const queueItem = createMockQueueItem({
        climb: createMockClimb({
          difficulty: '7a/V6',
        }),
      });

      const result = buildNavigationItem(queueItem);

      expect(result.gradeColor).toBe('#E22A2A'); // V6 color
    });

    it('should return default gray color for null difficulty', () => {
      const queueItem = createMockQueueItem({
        climb: createMockClimb({
          difficulty: null as unknown as string,
        }),
      });

      const result = buildNavigationItem(queueItem);

      expect(result.gradeColor).toBe('#808080'); // Default gray
    });
  });

  describe('buildNavigationContext', () => {
    it('should return empty context for empty queue', () => {
      const result = buildNavigationContext([], -1);

      expect(result.previousClimbs).toEqual([]);
      expect(result.nextClimb).toBeNull();
      expect(result.currentIndex).toBe(0);
      expect(result.totalCount).toBe(0);
    });

    it('should return no previous climbs when at start of queue', () => {
      const queue = [
        createMockQueueItem({ uuid: 'item-1' }),
        createMockQueueItem({ uuid: 'item-2' }),
        createMockQueueItem({ uuid: 'item-3' }),
      ];

      const result = buildNavigationContext(queue, 0);

      expect(result.previousClimbs).toHaveLength(0);
      expect(result.nextClimb).not.toBeNull();
      expect(result.currentIndex).toBe(0);
      expect(result.totalCount).toBe(3);
    });

    it('should return no next climb when at end of queue', () => {
      const queue = [
        createMockQueueItem({ uuid: 'item-1' }),
        createMockQueueItem({ uuid: 'item-2' }),
        createMockQueueItem({ uuid: 'item-3' }),
      ];

      const result = buildNavigationContext(queue, 2);

      expect(result.previousClimbs).toHaveLength(2);
      expect(result.nextClimb).toBeNull();
      expect(result.currentIndex).toBe(2);
      expect(result.totalCount).toBe(3);
    });

    it('should return up to 3 previous climbs (most recent first)', () => {
      const queue = [
        createMockQueueItem({ uuid: 'item-1', climb: createMockClimb({ name: 'Climb 1' }) }),
        createMockQueueItem({ uuid: 'item-2', climb: createMockClimb({ name: 'Climb 2' }) }),
        createMockQueueItem({ uuid: 'item-3', climb: createMockClimb({ name: 'Climb 3' }) }),
        createMockQueueItem({ uuid: 'item-4', climb: createMockClimb({ name: 'Climb 4' }) }),
        createMockQueueItem({ uuid: 'item-5', climb: createMockClimb({ name: 'Climb 5' }) }),
      ];

      const result = buildNavigationContext(queue, 4); // At Climb 5

      expect(result.previousClimbs).toHaveLength(3);
      // Most recent first (Climb 4, Climb 3, Climb 2)
      expect(result.previousClimbs[0].name).toBe('Climb 4');
      expect(result.previousClimbs[1].name).toBe('Climb 3');
      expect(result.previousClimbs[2].name).toBe('Climb 2');
    });

    it('should return 1 previous climb when only 1 available', () => {
      const queue = [
        createMockQueueItem({ uuid: 'item-1', climb: createMockClimb({ name: 'Climb 1' }) }),
        createMockQueueItem({ uuid: 'item-2', climb: createMockClimb({ name: 'Climb 2' }) }),
      ];

      const result = buildNavigationContext(queue, 1);

      expect(result.previousClimbs).toHaveLength(1);
      expect(result.previousClimbs[0].name).toBe('Climb 1');
    });

    it('should return next climb when available', () => {
      const queue = [
        createMockQueueItem({ uuid: 'item-1', climb: createMockClimb({ name: 'Climb 1' }) }),
        createMockQueueItem({ uuid: 'item-2', climb: createMockClimb({ name: 'Climb 2' }) }),
        createMockQueueItem({ uuid: 'item-3', climb: createMockClimb({ name: 'Climb 3' }) }),
      ];

      const result = buildNavigationContext(queue, 1);

      expect(result.nextClimb).not.toBeNull();
      expect(result.nextClimb?.name).toBe('Climb 3');
    });

    it('should handle single-item queue', () => {
      const queue = [createMockQueueItem({ uuid: 'item-1', climb: createMockClimb({ name: 'Only Climb' }) })];

      const result = buildNavigationContext(queue, 0);

      expect(result.previousClimbs).toHaveLength(0);
      expect(result.nextClimb).toBeNull();
      expect(result.currentIndex).toBe(0);
      expect(result.totalCount).toBe(1);
    });

    it('should handle middle of queue', () => {
      const queue = [
        createMockQueueItem({ uuid: 'item-1', climb: createMockClimb({ name: 'Climb 1' }) }),
        createMockQueueItem({ uuid: 'item-2', climb: createMockClimb({ name: 'Climb 2' }) }),
        createMockQueueItem({ uuid: 'item-3', climb: createMockClimb({ name: 'Climb 3' }) }),
      ];

      const result = buildNavigationContext(queue, 1);

      expect(result.previousClimbs).toHaveLength(1);
      expect(result.previousClimbs[0].name).toBe('Climb 1');
      expect(result.nextClimb?.name).toBe('Climb 3');
      expect(result.currentIndex).toBe(1);
      expect(result.totalCount).toBe(3);
    });

    it('should clamp negative currentIndex to 0', () => {
      const queue = [createMockQueueItem({ uuid: 'item-1' }), createMockQueueItem({ uuid: 'item-2' })];

      const result = buildNavigationContext(queue, -1);

      expect(result.currentIndex).toBe(0);
    });
  });

  describe('findClimbIndex', () => {
    it('should find climb by queue item UUID', () => {
      const queue = [
        createMockQueueItem({ uuid: 'item-1' }),
        createMockQueueItem({ uuid: 'item-2' }),
        createMockQueueItem({ uuid: 'item-3' }),
      ];

      expect(findClimbIndex(queue, 'item-1')).toBe(0);
      expect(findClimbIndex(queue, 'item-2')).toBe(1);
      expect(findClimbIndex(queue, 'item-3')).toBe(2);
    });

    it('should return -1 for non-existent UUID', () => {
      const queue = [createMockQueueItem({ uuid: 'item-1' }), createMockQueueItem({ uuid: 'item-2' })];

      expect(findClimbIndex(queue, 'non-existent')).toBe(-1);
    });

    it('should return -1 for undefined UUID', () => {
      const queue = [createMockQueueItem({ uuid: 'item-1' }), createMockQueueItem({ uuid: 'item-2' })];

      expect(findClimbIndex(queue, undefined)).toBe(-1);
    });

    it('should return -1 for empty queue', () => {
      expect(findClimbIndex([], 'some-uuid')).toBe(-1);
    });

    it('should find first matching UUID when duplicates exist', () => {
      // This shouldn't happen in practice but tests the implementation
      const queue = [
        createMockQueueItem({ uuid: 'duplicate' }),
        createMockQueueItem({ uuid: 'duplicate' }),
        createMockQueueItem({ uuid: 'unique' }),
      ];

      expect(findClimbIndex(queue, 'duplicate')).toBe(0);
    });
  });
});
