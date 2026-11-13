import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authorizeBetaReviewReplacement,
  betaReviewReplacementBehavior,
  checkReviewPending,
  reviewPendingDecision,
  reviewPendingOrFailOpen,
} from '../mobile-store-android-review-pending';

const release = (versionCode: number, state: string) => ({
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  activeArtifacts: [{ versionCode }],
});
afterEach(() => vi.unstubAllGlobals());

describe('explicit beta review replacement', () => {
  const tracks = (betaReleases = [release(2001646, 'IN_REVIEW')]) => [
    { track: 'production' as const, releases: [release(2001500, 'PUBLISHED')] },
    { track: 'beta' as const, releases: betaReleases },
  ];

  it('authorizes only the exact selected beta review', () => {
    expect(betaReviewReplacementBehavior(tracks(), 2001646)).toBe('CANCEL_IN_REVIEW_AND_SUBMIT');
    expect(() => betaReviewReplacementBehavior(tracks(), 2001645)).toThrow(/no longer matches/);
  });

  it('keeps strict review protection if the selected review already finished', () => {
    expect(betaReviewReplacementBehavior(tracks([release(2001646, 'PUBLISHED')]), 2001646)).toBe('ERROR_IF_IN_REVIEW');
    expect(betaReviewReplacementBehavior(tracks([]), 2001646)).toBe('ERROR_IF_IN_REVIEW');
  });

  it('refuses production reviews, incomplete evidence, and ambiguous beta reviews', () => {
    expect(() =>
      betaReviewReplacementBehavior(
        [{ track: 'production', releases: [release(2001500, 'IN_REVIEW')] }, tracks()[1]!],
        2001646,
      ),
    ).toThrow(/production release/);
    expect(() => betaReviewReplacementBehavior([tracks()[1]!], 2001646)).toThrow(/Both production and beta/);
    expect(() =>
      betaReviewReplacementBehavior(tracks([release(2001646, 'IN_REVIEW'), release(2001647, 'IN_REVIEW')]), 2001646),
    ).toThrow(/no longer matches/);
    expect(() =>
      betaReviewReplacementBehavior(
        tracks([
          {
            ...release(2001646, 'IN_REVIEW'),
            activeArtifacts: [{ versionCode: 2001646 }, { versionCode: 2001647 }],
          },
        ]),
        2001646,
      ),
    ).toThrow(/no longer matches/);
  });

  it('re-reads production and beta using GET-only requests', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [release(2001500, 'PUBLISHED')] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [release(2001646, 'IN_REVIEW')] })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(authorizeBetaReviewReplacement({ accessToken: 'secret', expectedVersionCode: 2001646 })).resolves.toBe(
      'CANCEL_IN_REVIEW_AND_SUBMIT',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/tracks\/production\/releases$/);
    expect(fetchMock.mock.calls[1]![0]).toMatch(/\/tracks\/beta\/releases$/);
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it('fails closed on unreadable review evidence and validates the selected code before reads', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('private response', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(authorizeBetaReviewReplacement({ accessToken: 'secret', expectedVersionCode: 0 })).rejects.toThrow(
      /positive/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      authorizeBetaReviewReplacement({ accessToken: 'secret', expectedVersionCode: 2001646 }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('Play review pre-check', () => {
  it.each(['production', 'beta'] as const)('holds the build while a %s release is in review', (track) => {
    const decision = reviewPendingDecision([
      { track: 'production', releases: [release(2001108, 'PUBLISHED')] },
      { track: 'beta', releases: [release(2001200, 'PUBLISHED')] },
      { track, releases: [release(2001310, 'IN_REVIEW')] },
    ]);
    expect(decision.pending).toBe(true);
    expect(decision.reason).toContain(`${track} (versionCode 2001310)`);
  });

  it.each(['DRAFT', 'NOT_SENT_FOR_REVIEW', 'APPROVED_NOT_PUBLISHED', 'PUBLISHED', 'NOT_APPROVED'])(
    'builds when the only other release is %s',
    (state) => {
      expect(
        reviewPendingDecision([
          { track: 'production', releases: [release(2001310, state)] },
          { track: 'beta', releases: [] },
        ]).pending,
      ).toBe(false);
    },
  );

  it('builds when both tracks are empty', () => {
    expect(
      reviewPendingDecision([
        { track: 'production', releases: [] },
        { track: 'beta', releases: [] },
      ]).pending,
    ).toBe(false);
  });

  it('reads only the non-edit production and beta summaries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [release(2001108, 'PUBLISHED')] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [release(2001310, 'IN_REVIEW')] })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkReviewPending({ accessToken: 'secret' })).toMatchObject({ pending: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/tracks\/production\/releases$/);
    expect(fetchMock.mock.calls[1]![0]).toMatch(/\/tracks\/beta\/releases$/);
    for (const call of fetchMock.mock.calls) expect(call[1]!.method).toBe('GET');
  });

  it('treats an empty track (HTTP 204) as nothing pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    expect(await checkReviewPending({ accessToken: 'secret' })).toMatchObject({ pending: false });
  });

  // The upload keeps its own ERROR_IF_IN_REVIEW guard, so an unreadable Play
  // costs at most one wasted build; holding every build on an outage would not.
  it('fails open when Play cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('nope', { status: 500 })));
    const decision = await reviewPendingOrFailOpen(() => checkReviewPending({ accessToken: 'secret' }));
    expect(decision).toMatchObject({ pending: false, failedOpen: true });
    expect(decision.reason).toContain('HTTP 500');
    expect(decision.reason).not.toContain('nope');
  });

  it('passes a readable answer through unchanged', async () => {
    expect(await reviewPendingOrFailOpen(async () => ({ pending: true, reason: 'in review' }))).toEqual({
      pending: true,
      reason: 'in review',
      failedOpen: false,
    });
  });
});
