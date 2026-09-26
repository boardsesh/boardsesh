// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Time-scoped dedupe for the two front-door sections: a wedged backend fails
 * every climb-view render for as long as it lasts, and Vercel/Railway bill
 * per log event, so this must cost at most ONE console.error (+ one Sentry
 * message) per section per `FRONT_DOOR_REPORT_INTERVAL_MS`, however many
 * times the backend flaps in between. Unlike the old once-per-outage `Set`
 * latch, a successful render no longer re-arms anything — see
 * `front-door-data.server.ts` for why that was the actual source of the
 * fanout (BOARDSESH-FF).
 */
const { createCachedGraphQLQueryMock, captureMessageMock, withScopeMock, scopeMock, queryImpl } = vi.hoisted(() => {
  const queryImpl: { current: () => Promise<unknown> } = {
    current: async () => ({ similarClimbs: [], betaLinks: [] }),
  };
  const scopeMock = {
    setFingerprint: vi.fn(),
    setTag: vi.fn(),
    setExtra: vi.fn(),
  };
  const captureMessageMock = vi.fn();
  return {
    queryImpl,
    scopeMock,
    captureMessageMock,
    createCachedGraphQLQueryMock: vi.fn(
      () =>
        (...args: unknown[]) =>
          queryImpl.current(...(args as [])) as never,
    ),
    withScopeMock: vi.fn((callback: (scope: typeof scopeMock) => void) => callback(scopeMock)),
  };
});

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  createCachedGraphQLQuery: createCachedGraphQLQueryMock,
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: captureMessageMock,
  withScope: withScopeMock,
}));

// Static import, matching front-door-data-timeout.test.ts and
// front-door-fanout.test.ts: this module's report-interval latch is
// process-level state shared by every test in this file (and, via the shared
// worker, other files that touch the same module graph). `beforeEach` below
// resets it explicitly via `__resetFrontDoorReportingForTests`, so each test
// starts clean regardless of execution order rather than relying on a fresh
// module instance per test.
import {
  __resetFrontDoorReportingForTests,
  getFrontDoorBetaLinks,
  getFrontDoorSimilarClimbs,
} from '../front-door-data.server';

describe('front-door time-scoped reporting', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let nowMs: number;

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

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureMessageMock.mockClear();
    withScopeMock.mockClear();
    scopeMock.setFingerprint.mockClear();
    scopeMock.setTag.mockClear();
    scopeMock.setExtra.mockClear();

    nowMs = 1_700_000_000_000;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    __resetFrontDoorReportingForTests();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    dateNowSpy.mockRestore();
  });

  it('logs and captures exactly once across two consecutive rejections (similar climbs)', async () => {
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

    expect(frontDoorLogCalls()).toHaveLength(2);
    expect(frontDoorCaptureCalls()).toHaveLength(1);
  });

  it('does not capture again for a second flap inside the 15-minute window (beta links)', async () => {
    queryImpl.current = async () => {
      throw new Error('wedged');
    };
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });
    expect(frontDoorCaptureCalls()).toHaveLength(1);

    // A successful render in between no longer re-arms anything.
    queryImpl.current = async () => ({ betaLinks: [] });
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });

    nowMs += 5 * 60_000; // 5 minutes later, still inside the 15-minute window
    queryImpl.current = async () => {
      throw new Error('wedged again');
    };
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });

    expect(frontDoorCaptureCalls()).toHaveLength(1);
  });

  it('captures again once the 15-minute window elapses', async () => {
    queryImpl.current = async () => {
      throw new Error('wedged');
    };
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });
    expect(frontDoorCaptureCalls()).toHaveLength(1);

    nowMs += 15 * 60_000 - 1; // one ms short of the window — still latched
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });
    expect(frontDoorCaptureCalls()).toHaveLength(1);

    nowMs += 1; // now exactly at the 15-minute window
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });
    expect(frontDoorCaptureCalls()).toHaveLength(2);
  });

  it('latches similar-climbs and beta-links independently', async () => {
    queryImpl.current = async () => {
      throw new Error('wedged');
    };

    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 });
    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-2', angle: 40 });
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-2' });

    expect(frontDoorCaptureCalls()).toHaveLength(2);
  });

  it('classifies a timeout, tags it, and never puts the retry text in the message', async () => {
    queryImpl.current = async () => {
      throw Object.assign(new Error('AbortError: This operation was aborted'), { name: 'AbortError' });
    };

    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 });

    expect(captureMessageMock).toHaveBeenCalledWith('Front door similar-climbs unavailable', 'warning');
    expect(scopeMock.setFingerprint).toHaveBeenCalledWith(['front-door-unavailable', 'similar-climbs', 'timeout']);
    expect(scopeMock.setTag).toHaveBeenCalledWith('front_door_error_class', 'timeout');
  });

  it('classifies a rate-limit error, tags it, and drops the retry-after seconds from the message', async () => {
    queryImpl.current = async () => {
      throw new Error('Rate limit exceeded. Try again in 29 seconds');
    };

    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });

    expect(captureMessageMock).toHaveBeenCalledWith('Front door beta-links unavailable', 'warning');
    expect(scopeMock.setFingerprint).toHaveBeenCalledWith(['front-door-unavailable', 'beta-links', 'rate-limited']);
    expect(scopeMock.setTag).toHaveBeenCalledWith('front_door_error_class', 'rate-limited');
    const capturedMessage = captureMessageMock.mock.calls[0]?.[0];
    expect(capturedMessage).not.toContain('29 seconds');
    expect(capturedMessage).not.toContain('Try again');
  });

  it('classifies anything else as a generic backend error', async () => {
    queryImpl.current = async () => {
      throw new Error('backend wedged');
    };

    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 });

    expect(scopeMock.setFingerprint).toHaveBeenCalledWith([
      'front-door-unavailable',
      'similar-climbs',
      'backend-error',
    ]);
    expect(scopeMock.setTag).toHaveBeenCalledWith('front_door_error_class', 'backend-error');
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
    const capturedExtras = JSON.stringify(scopeMock.setExtra.mock.calls);

    expect(loggedPayload).not.toContain('similarClimbs(input');
    expect(loggedPayload).not.toContain('threshold');
    expect(capturedMessage).not.toContain('similarClimbs(input');
    expect(capturedMessage).not.toContain('threshold');
    expect(capturedExtras).not.toContain('similarClimbs(input');
  });
});
