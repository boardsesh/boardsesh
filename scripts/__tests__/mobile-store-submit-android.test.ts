import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  androidSubmissionStatus,
  classifyAndroidSubmission,
  isInReviewRefusal,
  parseVersionCodeList,
  submitAndroidProduction,
} from '../mobile-store-submit-android';

const VERSION = 2001310;
const LIVE = 2001108;
const release = (versionCode: number, state: string) => ({
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  activeArtifacts: [{ versionCode }],
});
const summary = (...releases: unknown[]) => ({ releases });
const internalEdit = {
  track: 'internal',
  releases: [{ name: '2.7.0', status: 'completed', versionCodes: [String(VERSION)] }],
};
const productionEdit = {
  track: 'production',
  releases: [
    { name: '2.6.0', status: 'completed', versionCodes: [String(LIVE)] },
    { name: '2.7.0', status: 'draft', versionCodes: [String(VERSION)] },
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
const requests = (fetchMock: ReturnType<typeof mockResponses>) =>
  fetchMock.mock.calls.map(([url, options]) => `${options?.method} ${(url as string).split('/com.boardsesh.app')[1]}`);
afterEach(() => vi.unstubAllGlobals());

describe('classifyAndroidSubmission', () => {
  type Tracks = Parameters<typeof classifyAndroidSubmission>[0]['production'];
  const classify = (
    production: unknown[],
    beta: unknown[] = [],
    versionCodes = [VERSION],
    internal: unknown[] = [release(VERSION, 'PUBLISHED')],
  ) =>
    classifyAndroidSubmission({
      versionCodes,
      production: production as Tracks,
      beta: beta as Tracks,
      internal: internal as Tracks,
    });

  it('is pending while the build is at most a draft beside the live release', () => {
    expect(classify([release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')]).status).toBe('pending');
    expect(classify([release(LIVE, 'PUBLISHED')]).status).toBe('pending');
    expect(classify([release(VERSION, 'NOT_SENT_FOR_REVIEW')]).status).toBe('pending');
  });

  it.each(['IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'PUBLISHED'])('is done once production has the build %s', (state) => {
    expect(classify([release(LIVE, 'PUBLISHED'), release(VERSION, state)])).toMatchObject({
      status: 'done',
      reason: expect.stringContaining(state),
    });
  });

  it('counts any build of the version, so a hand-released older build is done too', () => {
    expect(classify([release(VERSION - 1, 'IN_REVIEW')], [], [VERSION - 1, VERSION]).status).toBe('done');
  });

  it('leaves a rejected build to a person instead of resubmitting it every hour', () => {
    expect(classify([release(VERSION, 'NOT_APPROVED')])).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('corrected tester build from main'),
    });
  });

  it('never releases under a newer production build, a draft included', () => {
    for (const state of ['DRAFT', 'IN_REVIEW', 'PUBLISHED']) {
      expect(classify([release(VERSION + 1, state)]).status, state).toBe('superseded');
    }
  });

  it('defers while Play reviews another release on production or beta', () => {
    expect(classify([release(LIVE, 'IN_REVIEW')])).toMatchObject({
      status: 'deferred',
      reason: expect.stringContaining('production'),
    });
    expect(classify([release(LIVE, 'PUBLISHED')], [release(VERSION, 'IN_REVIEW')])).toMatchObject({
      status: 'deferred',
      reason: expect.stringContaining('beta'),
    });
  });

  it('needs a person when the version has no tagged build', () => {
    expect(classify([release(LIVE, 'PUBLISHED')], [], [])).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('No Android build'),
    });
  });

  // Android Production Release only releases what internal holds, so a newer
  // tester build landing first strands the version; say so instead of failing hourly.
  it('needs a person once internal has moved on to a newer build', () => {
    expect(classify([release(LIVE, 'PUBLISHED')], [], [VERSION], [release(VERSION + 1, 'PUBLISHED')])).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('internal track no longer serves'),
    });
    // A build already submitted stays done whatever internal holds now.
    expect(classify([release(VERSION, 'IN_REVIEW')], [], [VERSION], []).status).toBe('done');
  });
});

describe('isInReviewRefusal', () => {
  const commit =
    'Google Play production request returned HTTP 400 (POST /edits/edit-1:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW)';

  it("reads only Google's own message on a refused commit", () => {
    expect(isInReviewRefusal(`${commit}: FAILED_PRECONDITION: Changes are currently in review.`)).toBe(true);
    expect(isInReviewRefusal(`${commit}: FAILED_PRECONDITION: The app is under review.`)).toBe(true);
    // The path names the review flags itself; that alone is no sign of a review.
    expect(isInReviewRefusal(commit)).toBe(false);
    expect(isInReviewRefusal(`${commit}: INVALID_ARGUMENT: Bad release notes.`)).toBe(false);
    // A real configuration error, not a wait.
    expect(
      isInReviewRefusal(
        `${commit}: Please set the query parameter changesNotSentForReview to true; changes in review.`,
      ),
    ).toBe(false);
    expect(
      isInReviewRefusal(
        'Google Play production request returned HTTP 400 (PUT /edits/edit-1/tracks/production): in review',
      ),
    ).toBe(false);
  });
});

describe('parseVersionCodeList', () => {
  it('reads space or comma separated codes once each', () => {
    expect(parseVersionCodeList(`${VERSION} ${VERSION - 1},${VERSION}\n`)).toEqual([VERSION, VERSION - 1]);
    expect(parseVersionCodeList('')).toEqual([]);
    expect(() => parseVersionCodeList('12 abc')).toThrow('ANDROID_VERSION_CODE');
  });
});

describe('androidSubmissionStatus', () => {
  it('reads only the non-edit production and beta summaries', async () => {
    const fetchMock = mockResponses([
      summary(release(VERSION, 'IN_REVIEW')),
      new Response(null, { status: 204 }),
      summary(release(VERSION, 'PUBLISHED')),
    ]);
    expect(await androidSubmissionStatus({ accessToken: 'secret', versionCodes: [VERSION] })).toMatchObject({
      status: 'done',
    });
    expect(requests(fetchMock)).toEqual([
      'GET /tracks/production/releases',
      'GET /tracks/beta/releases',
      'GET /tracks/internal/releases',
    ]);
  });
});

describe('submitAndroidProduction', () => {
  const pendingReads = () => [
    summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
    summary(),
    summary(release(VERSION, 'PUBLISHED')),
  ];

  it('plans without opening an edit', async () => {
    const fetchMock = mockResponses([
      ...pendingReads(),
      summary(release(VERSION, 'PUBLISHED')),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
    ]);
    expect(await submitAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: false })).toMatchObject({
      action: 'plan',
      status: 'pending',
      plan: { action: 'plan', rolloutPercent: 100 },
    });
    expect(requests(fetchMock).every((entry) => entry.startsWith('GET'))).toBe(true);
  });

  it('releases the exact build to everyone at 100% through Android Production Release', async () => {
    const fetchMock = mockResponses([
      ...pendingReads(),
      summary(release(VERSION, 'PUBLISHED')),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
      { id: 'edit-1' },
      internalEdit,
      productionEdit,
      { track: 'production' },
      {},
      {},
      summary(release(VERSION, 'IN_REVIEW')),
    ]);
    expect(await submitAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'submitted',
      status: 'done',
    });
    const put = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(JSON.parse(put![1]!.body as string)).toEqual({
      track: 'production',
      releases: [{ name: '2.7.0', status: 'completed', versionCodes: [String(VERSION)] }],
    });
    expect(requests(fetchMock)).toContain(
      'POST /edits/edit-1:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW',
    );
  });

  it.each([
    ['done', summary(release(VERSION, 'PUBLISHED')), summary()],
    ['deferred', summary(release(LIVE, 'PUBLISHED')), summary(release(LIVE + 1, 'IN_REVIEW'))],
    ['blocked', summary(release(VERSION, 'NOT_APPROVED')), summary()],
  ])('writes nothing when the build is %s', async (status, production, beta) => {
    const fetchMock = mockResponses([production, beta, summary(release(VERSION, 'PUBLISHED'))]);
    expect(await submitAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'none',
      status,
    });
    expect(requests(fetchMock).every((entry) => entry.startsWith('GET'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('turns a commit Play refused for a review that started meanwhile into a deferred retry', async () => {
    const fetchMock = mockResponses([
      ...pendingReads(),
      summary(release(VERSION, 'PUBLISHED')),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
      { id: 'edit-1' },
      internalEdit,
      productionEdit,
      { track: 'production' },
      {},
      new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION', message: 'in review' } }), { status: 400 }),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
      summary(release(LIVE + 1, 'IN_REVIEW')),
      summary(release(VERSION, 'PUBLISHED')),
    ]);
    expect(await submitAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'none',
      status: 'deferred',
      refusal: expect.stringContaining('HTTP 400'),
    });
    expect(requests(fetchMock).filter((entry) => entry.includes(':commit'))).toHaveLength(1);
  });

  it('defers a refusal that says changes are in review even when no release shows it', async () => {
    mockResponses([
      ...pendingReads(),
      summary(release(VERSION, 'PUBLISHED')),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
      { id: 'edit-1' },
      internalEdit,
      productionEdit,
      { track: 'production' },
      {},
      new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION', message: 'Changes are in review.' } }), {
        status: 400,
      }),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
      summary(),
      summary(release(VERSION, 'PUBLISHED')),
    ]);
    expect(await submitAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).toMatchObject({
      action: 'none',
      status: 'deferred',
      reason: expect.stringContaining('listing changes'),
    });
  });

  it('fails when a refused commit leaves nothing in review', async () => {
    mockResponses([
      ...pendingReads(),
      summary(release(VERSION, 'PUBLISHED')),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
      { id: 'edit-1' },
      internalEdit,
      productionEdit,
      { track: 'production' },
      {},
      new Response('{}', { status: 500 }),
      summary(release(LIVE, 'PUBLISHED'), release(VERSION, 'DRAFT')),
      summary(),
      summary(release(VERSION, 'PUBLISHED')),
    ]);
    await expect(submitAndroidProduction({ accessToken: 'secret', versionCode: VERSION, apply: true })).rejects.toThrow(
      'HTTP 500',
    );
  });
});
