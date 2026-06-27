import { describe, it, expect } from 'vite-plus/test';
import { SubmitAppFeedbackInputSchema } from '../validation/schemas';

describe('SubmitAppFeedbackInputSchema', () => {
  const BASE = {
    platform: 'web' as const,
    appVersion: '1.0.0',
  };

  describe('rating sources', () => {
    it('accepts a valid rating + comment submission', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 4,
        comment: 'Nice',
        source: 'drawer-feedback',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a rating submission with no comment', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 5,
        source: 'prompt',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a rating submission without a rating', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        source: 'prompt',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an out-of-range rating', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 7,
        source: 'drawer-feedback',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('bug sources', () => {
    it('accepts a bug report with no rating and a ≥10-char comment', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'Crashed on submit',
        source: 'shake-bug',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rating ?? null).toBeNull();
      }
    });

    it('accepts drawer-bug source same as shake-bug', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'Screen went blank',
        source: 'drawer-bug',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a bug report without a comment', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        source: 'shake-bug',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a bug report with a too-short comment', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'short',
        source: 'shake-bug',
      });
      expect(result.success).toBe(false);
    });
  });

  it('rejects an unknown source', () => {
    const result = SubmitAppFeedbackInputSchema.safeParse({
      ...BASE,
      rating: 5,
      source: 'bogus',
    });
    expect(result.success).toBe(false);
  });

  describe('board + context enrichment', () => {
    it('accepts a submission with full board + context metadata', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 4,
        source: 'drawer-feedback',
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 5,
        setIds: [1, 2],
        angle: 40,
        context: {
          climbUuid: 'abc123',
          climbName: 'Test Climb',
          difficulty: 'V5',
          sessionId: 'sess-1',
          url: '/kilter/1/5/1,2/40',
          userAgent: 'Mozilla/5.0',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a submission with no board context (e.g. anonymous from /)', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'crashed when submitting',
        source: 'shake-bug',
      });
      expect(result.success).toBe(true);
    });

    it('accepts an arbitrary board name (we add new boards over time)', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 5,
        source: 'prompt',
        boardName: 'grasshopper',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a board name longer than 100 chars (cheap abuse guard)', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 5,
        source: 'prompt',
        boardName: 'x'.repeat(101),
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty-string board name (use null instead of "")', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 5,
        source: 'prompt',
        boardName: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an out-of-range angle', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 5,
        source: 'prompt',
        angle: 360,
      });
      expect(result.success).toBe(false);
    });

    it('rejects context with unknown keys', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        rating: 5,
        source: 'prompt',
        context: { sneaky: 'payload' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts a bleDiagnostics context string on a bug report', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'bluetooth keeps dropping',
        source: 'drawer-bug',
        context: { bleDiagnostics: 'Devices found (1):\n- Kilter A1B2 | id=xyz | rssi -52' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects bleDiagnostics longer than 2000 chars', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'bluetooth keeps dropping',
        source: 'drawer-bug',
        context: { bleDiagnostics: 'x'.repeat(2001) },
      });
      expect(result.success).toBe(false);
    });
  });
});
