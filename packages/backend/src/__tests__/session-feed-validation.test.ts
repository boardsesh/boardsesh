import { describe, it, expect } from 'vite-plus/test';
import { ActivityFeedInputSchema } from '../validation/schemas';

describe('Session Feed Input Validation', () => {
  describe('ActivityFeedInputSchema (used by sessionGroupedFeed)', () => {
    it('provides defaults for missing fields', () => {
      const result = ActivityFeedInputSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
      }
    });

    it('rejects negative limit', () => {
      const result = ActivityFeedInputSchema.safeParse({ limit: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects zero limit', () => {
      const result = ActivityFeedInputSchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects limit over 50', () => {
      const result = ActivityFeedInputSchema.safeParse({ limit: 51 });
      expect(result.success).toBe(false);
    });

    it('accepts valid boardUuid', () => {
      const result = ActivityFeedInputSchema.safeParse({ boardUuid: 'abc-123' });
      expect(result.success).toBe(true);
    });

    it('accepts null boardUuid', () => {
      const result = ActivityFeedInputSchema.safeParse({ boardUuid: null });
      expect(result.success).toBe(true);
    });

    it('accepts valid cursor string', () => {
      const result = ActivityFeedInputSchema.safeParse({ cursor: 'abc123' });
      expect(result.success).toBe(true);
    });

    it('accepts session feed flags', () => {
      const result = ActivityFeedInputSchema.safeParse({
        followingOnly: true,
        includeDailyHighlights: true,
      });
      expect(result.success).toBe(true);
    });
  });
});
