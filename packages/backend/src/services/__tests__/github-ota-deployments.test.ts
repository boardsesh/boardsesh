/**
 * The switcher's "building" rows come from these states, so the two things that
 * matter are the mapping (a tester must never be told a preview is ready when
 * it is not) and that a GitHub failure degrades to "no information" rather than
 * throwing into the resolver.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  buildOtaBuildStates,
  buildingPrNumbers,
  readOtaBuildStates,
  resetOtaDeploymentCache,
  toOtaBuildState,
} from '../github-ota-deployments';

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const resolveGithubToken = vi.fn(async (): Promise<string | undefined> => 'ghs_token');
vi.mock('../../lib/github-client', () => ({
  resolveGithubToken: () => resolveGithubToken(),
  resolveQaGithubRepo: () => 'boardsesh/boardsesh',
}));

const NOW = Date.parse('2026-09-05T12:00:00.000Z');

const node = (prNumber: number, state: string | null, createdAt = '2026-09-05T11:00:00Z') => ({
  description: `OTA preview pr-${prNumber}`,
  createdAt,
  latestStatus: state === null ? null : { state },
});

function stubGraphQL(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const deploymentsPayload = (nodes: unknown[]) => ({ data: { repository: { deployments: { nodes } } } });

beforeEach(() => {
  resetOtaDeploymentCache();
  resolveGithubToken.mockResolvedValue('ghs_token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('toOtaBuildState', () => {
  it.each([
    ['QUEUED', 'building'],
    ['PENDING', 'building'],
    ['IN_PROGRESS', 'building'],
    ['SUCCESS', 'ready'],
    ['ACTIVE', 'ready'],
    ['FAILURE', 'failed'],
    ['ERROR', 'failed'],
    ['INACTIVE', 'unavailable'],
  ])('maps %s to %s', (githubState, expected) => {
    expect(toOtaBuildState(githubState)).toBe(expected);
  });

  it('treats a missing or unrecognised state as unknown', () => {
    expect(toOtaBuildState(null)).toBe('unknown');
    expect(toOtaBuildState(undefined)).toBe('unknown');
    expect(toOtaBuildState('WAITING')).toBe('unknown');
  });
});

describe('buildOtaBuildStates', () => {
  it('keys states by the PR number in the deployment description', () => {
    const states = buildOtaBuildStates([node(4792, 'IN_PROGRESS'), node(4801, 'SUCCESS')]);
    expect(states.get(4792)).toBe('building');
    expect(states.get(4801)).toBe('ready');
  });

  it('keeps the newest deployment per PR', () => {
    // GitHub returns newest-first, so the first node seen for a PR wins.
    const states = buildOtaBuildStates([
      node(4792, 'IN_PROGRESS', '2026-09-05T11:00:00Z'),
      node(4792, 'SUCCESS', '2026-09-05T09:00:00Z'),
    ]);
    expect(states.get(4792)).toBe('building');
    expect(states.size).toBe(1);
  });

  it('ignores deployments that are not an OTA preview', () => {
    const states = buildOtaBuildStates([
      { description: 'Production deploy', createdAt: null, latestStatus: { state: 'SUCCESS' } },
      { description: 'OTA preview pr-0', createdAt: null, latestStatus: { state: 'SUCCESS' } },
      { description: 'OTA preview pr-12 extra', createdAt: null, latestStatus: { state: 'SUCCESS' } },
      { description: null, createdAt: null, latestStatus: { state: 'SUCCESS' } },
      null,
    ]);
    expect(states.size).toBe(0);
  });
});

describe('buildingPrNumbers', () => {
  it('names only the PRs that are publishing', () => {
    const states = buildOtaBuildStates([node(1, 'IN_PROGRESS'), node(2, 'SUCCESS'), node(3, 'QUEUED')]);
    expect(buildingPrNumbers(states).sort((left, right) => left - right)).toEqual([1, 3]);
  });
});

describe('readOtaBuildStates', () => {
  it('reads the deployments and caches them', async () => {
    const fetchMock = stubGraphQL(deploymentsPayload([node(4792, 'IN_PROGRESS')]));

    const first = await readOtaBuildStates(NOW);
    expect(first.get(4792)).toBe('building');

    await readOtaBuildStates(NOW + 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refills once the cache expires', async () => {
    const fetchMock = stubGraphQL(deploymentsPayload([node(4792, 'IN_PROGRESS')]));
    await readOtaBuildStates(NOW);
    await readOtaBuildStates(NOW + 61_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips GitHub entirely when the App is not configured', async () => {
    resolveGithubToken.mockResolvedValue(undefined);
    const fetchMock = stubGraphQL(deploymentsPayload([]));

    await expect(readOtaBuildStates(NOW)).resolves.toEqual(new Map());
    // GraphQL has no anonymous tier — asking would only spend a round trip on a 401.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves an empty map rather than throwing when GitHub errors', async () => {
    stubGraphQL('nope', 502);
    await expect(readOtaBuildStates(NOW)).resolves.toEqual(new Map());
  });

  it('treats a 200 carrying GraphQL errors as a failure', async () => {
    stubGraphQL({ errors: [{ message: 'Bad credentials' }] });
    await expect(readOtaBuildStates(NOW)).resolves.toEqual(new Map());
  });

  it('negative-caches a failure so an outage cannot become a request storm', async () => {
    const fetchMock = stubGraphQL('nope', 502);
    await readOtaBuildStates(NOW);
    await readOtaBuildStates(NOW + 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ...and retries once the shorter error TTL elapses.
    await readOtaBuildStates(NOW + 31_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent readers onto one request', async () => {
    const fetchMock = stubGraphQL(deploymentsPayload([node(4792, 'IN_PROGRESS')]));
    await Promise.all([readOtaBuildStates(NOW), readOtaBuildStates(NOW), readOtaBuildStates(NOW)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
