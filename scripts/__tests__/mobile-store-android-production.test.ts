import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseRolloutPercent, promoteAndroidProduction } from '../mobile-store-android-production';

const VERSION = 2001310;
const LIVE = 2001108;
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
      versionCodes: [String(VERSION), '2001309'],
      releaseNotes: [{ language: 'en-US', text: 'Climb with your crew', private: 'discard' }],
      countryTargeting: { countries: ['ES'] },
      private: 'discard',
    },
  ],
};
// What Play holds today: the live 2.5.x release plus the 2.6.0 draft the store-draft workflow made.
const productionEdit = {
  track: 'production',
  releases: [
    {
      name: '2.5.2',
      status: 'completed',
      versionCodes: [String(LIVE)],
      releaseNotes: [{ language: 'en-US', text: 'Older notes' }],
      countryTargeting: { countries: ['ES'] },
    },
    { name: '2.6.0', status: 'draft', versionCodes: [String(VERSION)] },
  ],
};
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
  summary(published(LIVE), published(VERSION, 'DRAFT')),
  { id: 'edit-123' },
  internalEdit,
  productionEdit,
  { track: 'production' },
  {},
  {},
  receipt,
];
const putBody = (fetchMock: ReturnType<typeof mockResponses>) =>
  JSON.parse(fetchMock.mock.calls[5]![1]!.body as string) as { track: string; releases: unknown[] };
afterEach(() => vi.unstubAllGlobals());

describe('Android production release', () => {
  it('plans with only independent non-edit reads', async () => {
    const fetchMock = mockResponses([summary(published()), summary(published(LIVE))]);
    expect(await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION })).toMatchObject({
      action: 'plan',
      targetTrack: 'production',
      rolloutPercent: 100,
      rolloutStatus: 'unknown',
    });
    expect(
      fetchMock.mock.calls.map(([url, options]) => [(url as string).split('/applications/')[1], options?.method]),
    ).toEqual([
      ['com.boardsesh.app/tracks/internal/releases', 'GET'],
      ['com.boardsesh.app/tracks/production/releases', 'GET'],
    ]);
  });

  it('releases the draft build to everyone at 100% and drops the old release and draft', async () => {
    const fetchMock = mockResponses(applyResponses());
    expect(await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'committed',
      publicationVerified: false,
    });
    expect(putBody(fetchMock)).toEqual({
      track: 'production',
      releases: [
        {
          name: '2.6.0',
          status: 'completed',
          versionCodes: [String(VERSION)],
          releaseNotes: [{ language: 'en-US', text: 'Climb with your crew' }],
        },
      ],
    });
    const calls = fetchMock.mock.calls;
    expect(calls[5]![0]).toMatch(/edits\/edit-123\/tracks\/production$/);
    expect(calls[5]![1]!.method).toBe('PUT');
    expect(calls[6]![0]).toMatch(/:validate$/);
    expect(calls[7]![0]).toMatch(/:commit\?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW$/);
    expect(calls[8]![0]).toMatch(/\/tracks\/production\/releases$/);
    expect(calls[8]![1]!.method).toBe('GET');
    expect(calls.every(([, options]) => options?.method !== 'DELETE')).toBe(true);
  });

  it('stages a partial rollout beside the live completed release', async () => {
    const fetchMock = mockResponses(applyResponses());
    await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, rolloutPercent: 20, apply: true });
    expect(putBody(fetchMock).releases).toEqual([
      {
        name: '2.6.0',
        status: 'inProgress',
        userFraction: 0.2,
        versionCodes: [String(VERSION)],
        releaseNotes: [{ language: 'en-US', text: 'Climb with your crew' }],
      },
      {
        name: '2.5.2',
        status: 'completed',
        versionCodes: [String(LIVE)],
        releaseNotes: [{ language: 'en-US', text: 'Older notes' }],
      },
    ]);
  });

  it('raises a staged rollout to 100% by completing it', async () => {
    const responses = applyResponses();
    responses[4] = {
      track: 'production',
      releases: [
        { status: 'inProgress', userFraction: 0.2, versionCodes: [String(VERSION)] },
        { status: 'completed', versionCodes: [String(LIVE)] },
      ],
    };
    const fetchMock = mockResponses(responses);
    await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true });
    expect(putBody(fetchMock).releases).toEqual([
      expect.objectContaining({ status: 'completed', versionCodes: [String(VERSION)] }),
    ]);
  });

  it.each([
    [summary(), summary(), 'PUBLISHED internal'],
    [summary(published(VERSION, 'DRAFT')), summary(), 'PUBLISHED internal'],
    [summary(published(), published()), summary(), 'PUBLISHED internal'],
    [summary(published()), summary(published(VERSION + 1)), 'downgrade'],
  ])('fails closed before creating an edit %#', async (internal, production, error) => {
    const fetchMock = mockResponses([internal, production]);
    await expect(
      promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true }),
    ).rejects.toThrow(error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...internalEdit, releases: [] },
    { ...internalEdit, releases: [{ status: 'draft', versionCodes: [String(VERSION)] }] },
  ])('rejects a missing or incomplete internal source inside the edit %#', async (source) => {
    const responses = applyResponses();
    responses[3] = source;
    const fetchMock = mockResponses(responses);
    await expect(
      promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true }),
    ).rejects.toThrow('completed internal');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    [{ track: 'production', releases: [{ status: 'draft', versionCodes: [String(VERSION + 1)] }] }, 'downgrade'],
    [
      {
        track: 'production',
        releases: [
          { status: 'draft', versionCodes: [String(VERSION)] },
          { status: 'halted', versionCodes: [String(VERSION)] },
        ],
      },
      'ambiguous',
    ],
    [{ track: 'beta', releases: [] }, 'wrong track'],
  ])('refuses an unsafe production edit before writing %#', async (edit, error) => {
    const responses = applyResponses();
    responses[4] = edit;
    const fetchMock = mockResponses(responses);
    await expect(
      promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true }),
    ).rejects.toThrow(error);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });

  it('refuses to shrink a completed release into a staged rollout', async () => {
    const responses = applyResponses();
    responses[4] = { track: 'production', releases: [{ status: 'completed', versionCodes: [String(VERSION)] }] };
    const fetchMock = mockResponses(responses);
    await expect(
      promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, rolloutPercent: 50, apply: true }),
    ).rejects.toThrow('cannot shrink');
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });

  it('refuses a staged rollout when Play holds two completed releases', async () => {
    const responses = applyResponses();
    responses[4] = {
      track: 'production',
      releases: [
        { status: 'completed', versionCodes: [String(LIVE)] },
        { status: 'completed', versionCodes: ['2001100'] },
      ],
    };
    mockResponses(responses);
    await expect(
      promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, rolloutPercent: 50, apply: true }),
    ).rejects.toThrow('more than one completed release');
  });

  it('skips track writes only when the build is already completed and PUBLISHED', async () => {
    const responses = applyResponses().slice(0, 5);
    responses[1] = summary(published());
    responses[4] = { track: 'production', releases: [{ status: 'completed', versionCodes: [String(VERSION)] }] };
    const fetchMock = mockResponses(responses);
    expect(await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'already-released',
      rolloutStatus: 'completed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });

  it('submits a completed edit release that still needs review', async () => {
    const responses = applyResponses();
    responses[1] = summary(published(VERSION, 'NOT_SENT_FOR_REVIEW'));
    responses[4] = { track: 'production', releases: [{ status: 'completed', versionCodes: [String(VERSION)] }] };
    const fetchMock = mockResponses(responses);
    expect(await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'committed',
    });
    expect(fetchMock.mock.calls[7]![0]).toContain('changesNotSentForReview=false');
  });

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'NOT_SENT_FOR_REVIEW'])(
    'does not claim publication for %s receipts',
    async (state) => {
      mockResponses(applyResponses(summary(published(VERSION, state))));
      expect(
        await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true }),
      ).toMatchObject({ publicationVerified: false });
    },
  );

  it('verifies publication only from an exact PUBLISHED receipt', async () => {
    mockResponses(applyResponses(summary(published())));
    expect(await promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      publicationVerified: true,
    });
  });

  it('does not retry or bypass review protection when commit rejects', async () => {
    const responses = applyResponses();
    responses[7] = new Response('private service-account diagnostic', { status: 409 });
    const fetchMock = mockResponses(responses);
    await expect(
      promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true }),
    ).rejects.toThrow('Google Play production request returned HTTP 409');
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('does not echo network errors containing credentials', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-token')));
    await expect(promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION })).rejects.toThrow(
      'Google Play production request failed',
    );
  });

  it.each(['0', '101', '20.5', '', '-5', '050', '1e2'])('rejects rollout input %j', (input) => {
    expect(() => parseRolloutPercent(input)).toThrow('1 to 100');
  });

  it.each([0, 101, 20.5, -5, Number.NaN])('rejects rollout percent %d before any request', async (rolloutPercent) => {
    const fetchMock = mockResponses([]);
    await expect(
      promoteAndroidProduction({ accessToken: 'secret', versionCode: VERSION, rolloutPercent }),
    ).rejects.toThrow('1 to 100');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['1', 1],
    ['20', 20],
    ['100', 100],
  ])('accepts rollout input %j', (input, expected) => {
    expect(parseRolloutPercent(input)).toBe(expected);
  });
});
