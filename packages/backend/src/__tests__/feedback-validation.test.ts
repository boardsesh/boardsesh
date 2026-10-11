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

    it('accepts an arbitrary number of setIds (BOARDSESH-84: the 16 cap ate bug reports)', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'switch board did nothing',
        source: 'shake-bug',
        setIds: Array.from({ length: 20 }, (_, index) => index + 1),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.setIds).toHaveLength(20);
      }
    });

    it('truncates an absurd setIds list rather than dropping the report', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'switch board did nothing',
        source: 'shake-bug',
        setIds: Array.from({ length: 500 }, (_, index) => index + 1),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.setIds).toHaveLength(64);
      }
    });
  });

  // The report is the payload; the board context around it is triage garnish. No
  // enrichment field may fail the parse — see the `bestEffort` note in
  // validation/schemas/feedback.ts and Sentry BOARDSESH-84.
  describe('enrichment degrades instead of rejecting', () => {
    const BUG = { ...BASE, comment: 'switch board did nothing', source: 'shake-bug' as const };

    it('drops a board name past the abuse guard', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({ ...BUG, boardName: 'x'.repeat(101) });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.boardName).toBeNull();
    });

    it('drops an empty-string board name', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({ ...BUG, boardName: '' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.boardName).toBeNull();
    });

    it('drops an out-of-range angle', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({ ...BUG, angle: 360 });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.angle).toBeNull();
    });

    it('drops a wrong-typed layoutId', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({ ...BUG, layoutId: 'one' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.layoutId).toBeNull();
    });

    it('strips unknown context keys instead of rejecting (newer client, older server)', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BUG,
        context: { sessionId: 'sess-1', sneaky: 'payload' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context?.sessionId).toBe('sess-1');
        expect(result.data.context).not.toHaveProperty('sneaky');
      }
    });

    it('drops context entirely when it is not even an object', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({ ...BUG, context: 'nope' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.context).toBeNull();
    });

    it('survives every enrichment field being garbage at once', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BUG,
        appVersion: 'v'.repeat(200),
        boardName: '',
        layoutId: {},
        sizeId: 'big',
        setIds: 'not-an-array',
        angle: -5,
        context: 42,
        contactConsent: 'yes',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.comment).toBe('switch board did nothing');
        expect(result.data.source).toBe('shake-bug');
      }
    });

    it('clips an over-long comment rather than losing the report', () => {
      const result = SubmitAppFeedbackInputSchema.safeParse({
        ...BASE,
        comment: 'x'.repeat(5000),
        source: 'shake-bug',
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.comment).toHaveLength(2000);
    });

    it('still rejects a submission missing the load-bearing fields', () => {
      expect(SubmitAppFeedbackInputSchema.safeParse({ ...BASE, source: 'shake-bug' }).success).toBe(false);
      expect(SubmitAppFeedbackInputSchema.safeParse({ ...BASE, rating: 5 }).success).toBe(false);
      expect(SubmitAppFeedbackInputSchema.safeParse({ comment: 'a'.repeat(20), source: 'shake-bug' }).success).toBe(
        false,
      );
    });
  });
});

describe('feedback private diagnostics', () => {
  it('keeps valid correlation while dropping malformed enrichment', () => {
    const report = SubmitAppFeedbackInputSchema.parse({
      platform: 'android',
      source: 'drawer-bug',
      comment: 'The app disappeared',
      context: {
        diagnostics: {
          schemaVersion: 1,
          launchId: 'launch-123',
          previousLaunchCrashed: false,
          reportId: 'r'.repeat(201),
          otaBranch: 42,
          accessToken: 'secret',
        },
      },
    });
    expect(report.context?.diagnostics).toEqual({
      schemaVersion: 1,
      launchId: 'launch-123',
      previousLaunchCrashed: false,
      reportId: null,
      otaBranch: null,
    });
  });

  it('does not lose the report when diagnostics have an invalid shape', () => {
    const report = SubmitAppFeedbackInputSchema.parse({
      platform: 'ios',
      source: 'drawer-bug',
      comment: 'The app disappeared',
      context: { climbName: 'Orbit', diagnostics: 'broken' },
    });
    expect(report.context).toEqual({ climbName: 'Orbit', diagnostics: null });
  });
});
