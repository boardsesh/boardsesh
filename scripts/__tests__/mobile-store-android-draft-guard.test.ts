import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkProductionDraft, productionDraftDecision } from '../mobile-store-android-draft-guard';

const VERSION = 2001310;
const release = (versionCode: number, state: string) => ({
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  activeArtifacts: [{ versionCode }],
});
afterEach(() => vi.unstubAllGlobals());

describe('production draft guard', () => {
  it('drafts while the build is only a draft beside the live release', () => {
    expect(productionDraftDecision([release(2001108, 'PUBLISHED'), release(VERSION, 'DRAFT')], VERSION)).toMatchObject({
      skip: false,
    });
    expect(productionDraftDecision([], VERSION).skip).toBe(false);
  });

  it.each(['NOT_SENT_FOR_REVIEW', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'PUBLISHED'])(
    'leaves production alone once the build is %s',
    (state) => {
      expect(productionDraftDecision([release(VERSION, state)], VERSION)).toMatchObject({
        skip: true,
        reason: expect.stringContaining(state),
      });
    },
  );

  it.each(['PUBLISHED', 'DRAFT', 'IN_REVIEW'])('refuses to draft over a newer build that is %s', (state) => {
    expect(productionDraftDecision([release(VERSION + 1, state)], VERSION)).toMatchObject({
      skip: true,
      reason: expect.stringContaining('newer versionCode'),
    });
  });

  // 2026-10-18: 2.6.0 (2001310) was in production review when the train uploaded
  // 2001360 and a store-draft run picked it.
  it.each(['NOT_SENT_FOR_REVIEW', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED'])(
    'refuses to draft a newer build while an older one is %s',
    (state) => {
      expect(
        productionDraftDecision(
          [release(VERSION, 'DRAFT'), release(VERSION, state), release(2001108, 'PUBLISHED')],
          VERSION + 50,
        ),
      ).toMatchObject({ skip: true, reason: expect.stringContaining(`versionCode ${VERSION} pending (`) });
    },
  );

  it.each(['PUBLISHED', 'NOT_APPROVED', 'DRAFT'])('still drafts a newer build beside an older %s release', (state) => {
    expect(productionDraftDecision([release(VERSION, state)], VERSION + 50).skip).toBe(false);
  });

  it('reads only the non-edit production summary', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [release(VERSION, 'IN_REVIEW')] })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkProductionDraft({ accessToken: 'secret', versionCode: VERSION })).toMatchObject({ skip: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/tracks\/production\/releases$/);
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('GET');
  });

  it('treats an empty production track (HTTP 204) as safe to draft', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })));
    expect(await checkProductionDraft({ accessToken: 'secret', versionCode: VERSION })).toMatchObject({ skip: false });
  });

  it('fails instead of guessing when Play errors', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('nope', { status: 500 })));
    await expect(checkProductionDraft({ accessToken: 'secret', versionCode: VERSION })).rejects.toThrow('HTTP 500');
  });
});
