import { afterEach, describe, expect, it, vi } from 'vitest';

import { promoteAndroidBeta } from '../mobile-store-android-beta';

const VERSION = 2001247;
const published = (versionCode = VERSION, state = 'PUBLISHED') => ({
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  activeArtifacts: [{ versionCode }],
});
const summary = (...releases: unknown[]) => ({ releases });
const internalEdit = {
  track: 'internal',
  releases: [
    {
      name: '2.6.0',
      status: 'completed',
      versionCodes: [String(VERSION), '2001246'],
      releaseNotes: [{ language: 'en-US', text: 'Climb with your crew', private: 'discard' }],
      userFraction: 0.1,
      countryTargeting: { countries: ['ES'] },
      private: 'discard',
    },
  ],
};
const betaEdit = { track: 'beta', releases: [{ status: 'completed', versionCodes: ['2001108'] }] };
function mockResponses(responses: unknown[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response instanceof Response ? response : new Response(JSON.stringify(response)));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const applyResponses = (receipt = summary(published(VERSION, 'IN_REVIEW'))): unknown[] => [
  summary(published()),
  summary(published(2001108)),
  { id: 'edit-123' },
  internalEdit,
  betaEdit,
  { track: 'beta' },
  {},
  {},
  receipt,
];
afterEach(() => vi.unstubAllGlobals());

describe('Android open testing promotion', () => {
  it('handles an empty beta summary (HTTP 204) and still rechecks the edit before writing', async () => {
    const responses = applyResponses();
    responses[1] = new Response(null, { status: 204 });
    const fetchMock = mockResponses(responses);
    expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'committed',
      publicationVerified: false,
    });
    expect(fetchMock.mock.calls[4]?.[0]).toMatch(/edits\/edit-123\/tracks\/beta$/);
  });

  it('plans with only independent non-edit reads', async () => {
    const fetchMock = mockResponses([summary(published()), summary(published(2001108))]);
    expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION })).toMatchObject({ action: 'plan' });
    expect(
      fetchMock.mock.calls.map(([url, options]) => [(url as string).split('/applications/')[1], options?.method]),
    ).toEqual([
      ['com.boardsesh.app/tracks/internal/releases', 'GET'],
      ['com.boardsesh.app/tracks/beta/releases', 'GET'],
    ]);
  });

  it.each([
    [summary(), summary(), 'PUBLISHED internal'],
    [summary(published(VERSION, 'DRAFT')), summary(), 'PUBLISHED internal'],
    [summary(published(), published()), summary(), 'PUBLISHED internal'],
    [summary(published()), summary(published(VERSION + 1)), 'downgrade'],
  ])('fails closed before creating an edit %#', async (internal, beta, error) => {
    const fetchMock = mockResponses([internal, beta]);
    await expect(promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).rejects.toThrow(
      error,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('submits only the selected artifact to beta and reads publication separately', async () => {
    const fetchMock = mockResponses(applyResponses());
    const report = await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true });
    expect(report).toMatchObject({ action: 'committed', publicationVerified: false });
    const calls = fetchMock.mock.calls;
    expect(JSON.parse(calls[5]![1]!.body as string)).toEqual({
      track: 'beta',
      releases: [
        {
          name: '2.6.0',
          status: 'completed',
          versionCodes: [String(VERSION)],
          releaseNotes: [{ language: 'en-US', text: 'Climb with your crew' }],
        },
      ],
    });
    expect(calls[6]![0]).toMatch(/:validate$/);
    expect(calls[7]![0]).toMatch(/:commit\?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW$/);
    expect(calls[8]![0]).toMatch(/\/tracks\/beta\/releases$/);
    expect(calls[8]![1]!.method).toBe('GET');
    expect(
      calls.every(([url, options]) => !(url as string).includes('production') && options?.method !== 'DELETE'),
    ).toBe(true);
  });

  it('does not retry or bypass review protection when commit rejects', async () => {
    const responses = applyResponses();
    responses[7] = new Response('private service-account diagnostic', { status: 409 });
    const fetchMock = mockResponses(responses);
    await expect(promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).rejects.toThrow(
      'Google Play beta request returned HTTP 409',
    );
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it.each([
    { ...internalEdit, releases: [] },
    { ...internalEdit, releases: [{ status: 'draft', versionCodes: [String(VERSION)] }] },
  ])('rejects a missing or incomplete source inside the edit %#', async (source) => {
    const responses = applyResponses();
    responses[3] = source;
    const fetchMock = mockResponses(responses);
    await expect(promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).rejects.toThrow(
      'completed internal',
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('detects a newer beta artifact inside the edit before writing', async () => {
    const responses = applyResponses();
    responses[4] = { track: 'beta', releases: [{ versionCodes: [String(VERSION + 1)] }] };
    const fetchMock = mockResponses(responses);
    await expect(promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).rejects.toThrow(
      'downgrade',
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'NOT_SENT_FOR_REVIEW'])(
    'does not claim publication for %s receipts',
    async (state) => {
      mockResponses(applyResponses(summary(published(VERSION, state))));
      expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
        publicationVerified: false,
      });
    },
  );

  it('verifies publication only from an exact PUBLISHED receipt', async () => {
    mockResponses(applyResponses(summary(published())));
    expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      publicationVerified: true,
    });
  });

  it('keeps read-only plans explicit about unknown rollout completion', async () => {
    const fetchMock = mockResponses([summary(published()), summary(published())]);
    expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION })).toMatchObject({
      action: 'plan',
      rolloutStatus: 'unknown',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['inProgress', 'halted'])('completes a PUBLISHED beta whose rollout is %s', async (status) => {
    const responses = applyResponses(summary(published()));
    responses[1] = summary(published());
    responses[4] = { track: 'beta', releases: [{ status, userFraction: 0.1, versionCodes: [String(VERSION)] }] };
    const fetchMock = mockResponses(responses);
    expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'committed',
    });
    expect(JSON.parse(fetchMock.mock.calls[5]![1]!.body as string).releases[0]).toMatchObject({
      status: 'completed',
      versionCodes: [String(VERSION)],
    });
    expect(fetchMock.mock.calls[7]![0]).toContain('changesInReviewBehavior=ERROR_IF_IN_REVIEW');
  });

  it.each(['DRAFT', 'NOT_SENT_FOR_REVIEW'])('submits completed edit releases whose lifecycle is %s', async (state) => {
    const responses = applyResponses();
    responses[1] = summary(published(VERSION, state));
    responses[4] = { track: 'beta', releases: [{ status: 'completed', versionCodes: [String(VERSION)] }] };
    const fetchMock = mockResponses(responses);
    expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'committed',
    });
    expect(fetchMock.mock.calls[7]![0]).toContain('changesNotSentForReview=false');
  });

  it('skips track writes only after reading exact completed rollout status', async () => {
    const responses = applyResponses().slice(0, 5);
    responses[1] = summary(published());
    responses[4] = { track: 'beta', releases: [{ status: 'completed', versionCodes: [String(VERSION)] }] };
    const fetchMock = mockResponses(responses);
    expect(await promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'already-completed',
      rolloutStatus: 'completed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });

  it('does not echo network errors containing credentials', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-token')));
    await expect(promoteAndroidBeta({ accessToken: 'secret', versionCode: VERSION })).rejects.toThrow(
      'Google Play beta request failed',
    );
  });
});
