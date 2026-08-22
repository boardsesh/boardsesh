// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Outage-scoped dedupe for the two front-door sections: a wedged backend fails
 * every climb-view render for as long as it lasts, and Vercel bills per log
 * event, so this must cost exactly ONE console.error (+ one Sentry message)
 * per outage rather than one per render. A success re-arms the key so the
 * NEXT distinct outage still gets logged.
 */
const { createCachedGraphQLQueryMock, captureMessageMock, queryImpl } = vi.hoisted(() => {
  const queryImpl: { current: () => Promise<unknown> } = {
    current: async () => ({ similarClimbs: [], betaLinks: [] }),
  };
  return {
    queryImpl,
    createCachedGraphQLQueryMock: vi.fn(
      () =>
        (...args: unknown[]) =>
          queryImpl.current(...(args as [])) as never,
    ),
    captureMessageMock: vi.fn(),
  };
});

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  createCachedGraphQLQuery: createCachedGraphQLQueryMock,
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: captureMessageMock,
}));

// Static import, matching front-door-data-timeout.test.ts and
// front-door-fanout.test.ts: this module's once-per-outage dedupe Set is
// process-level state shared by every test in this file (and, via the shared
// worker, other files that touch the same module graph). `beforeEach` below
// drives both sections back to a known "recovered" state explicitly, so each
// test starts clean regardless of execution order rather than relying on a
// fresh module instance per test.
import { getFrontDoorBetaLinks, getFrontDoorSimilarClimbs } from '../front-door-data.server';

describe('front-door outage-scoped logging', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  // Filtered rather than a raw call count on the spy: `console` and
  // `@sentry/nextjs` are process-wide, and unrelated logging elsewhere in the
  // same worker (or a straggling async task from another test file) could in
  // principle land on the same spy. Scoping to this module's own log prefix
  // keeps the assertion about OUR dedupe logic specifically.
  const frontDoorLogCalls = () =>
    consoleErrorSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('Front door:'),
    );
  const frontDoorCaptureCalls = () =>
    captureMessageMock.mock.calls.filter((call) => typeof call[0] === 'string' && call[0].startsWith('Front door '));

  beforeEach(async () => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureMessageMock.mockClear();

    // Recover both sections so every test starts from a clean, un-latched
    // dedupe key, regardless of what a previous test left behind.
    queryImpl.current = async () => ({ similarClimbs: [], betaLinks: [] });
    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'warmup', angle: 40 });
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'warmup' });
    consoleErrorSpy.mockClear();
    captureMessageMock.mockClear();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('logs exactly once across two consecutive rejections (similar climbs)', async () => {
    const requestError = Object.assign(
      new Error(
        'GraphQL Error (Code: 500): {"response":{"errors":[{"message":"backend wedged"}]},"request":{"query":"query SimilarClimbs($input: SimilarClimbsInput!) { similarClimbs(input: $input) { uuid } }","variables":{"input":{"boardType":"kilter"}}}}',
      ),
      { response: { errors: [{ message: 'backend wedged' }] } },
    );
    queryImpl.current = async () => {
      throw requestError;
    };

    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 });
    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-2', angle: 40 });

    expect(frontDoorLogCalls()).toHaveLength(1);
    expect(frontDoorCaptureCalls()).toHaveLength(1);
  });

  it('logs again after a success re-arms the key (beta links)', async () => {
    queryImpl.current = async () => {
      throw new Error('wedged');
    };
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });
    expect(frontDoorLogCalls()).toHaveLength(1);

    queryImpl.current = async () => ({ betaLinks: [] });
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });

    queryImpl.current = async () => {
      throw new Error('wedged again');
    };
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });

    expect(frontDoorLogCalls()).toHaveLength(2);
    expect(frontDoorCaptureCalls()).toHaveLength(2);
  });

  it('never lets the request query/variables text reach the logged payload', async () => {
    const requestError = Object.assign(
      new Error(
        'GraphQL Error (Code: 500): {"response":{"errors":[{"message":"backend wedged"}]},"request":{"query":"query SimilarClimbs($input: SimilarClimbsInput!) { similarClimbs(input: $input) { uuid name difficulty } }","variables":{"input":{"boardType":"kilter","layoutId":8,"climbUuid":"climb-1","angle":40,"threshold":0.5,"limit":10}}}}',
      ),
      { response: { errors: [{ message: 'backend wedged' }] } },
    );
    queryImpl.current = async () => {
      throw requestError;
    };

    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 });

    const loggedPayload = JSON.stringify(frontDoorLogCalls()[0]);
    const capturedMessage = JSON.stringify(frontDoorCaptureCalls()[0]);

    expect(loggedPayload).not.toContain('similarClimbs(input');
    expect(loggedPayload).not.toContain('threshold');
    expect(capturedMessage).not.toContain('similarClimbs(input');
    expect(capturedMessage).not.toContain('threshold');
  });
});
