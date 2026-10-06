// The post-publish bind, on fake timers.
//
// TestFlight found the add-a-wall flow parked forever on "Setting your wall
// up…" with the wall published and never bound. These pin the three ways out
// of that spinner: a refresh that never settles is not waited on, a stage that
// hangs becomes an error naming itself, and a dismiss that does not land is
// noticed and retried. Plus the one rule that keeps the retry safe: a run that
// gave up cannot bind or navigate later.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const breadcrumbs = vi.hoisted(() => vi.fn<(breadcrumb: { category: string; message: string }) => void>());
const reportErrorMock = vi.hoisted(() => vi.fn<(error: unknown, context?: unknown) => void>());
const trackSprayEventMock = vi.hoisted(() =>
  vi.fn<(payload: { name: string; properties: Record<string, unknown> }) => void>(),
);

vi.mock('../../error-reporting', () => ({ addErrorBreadcrumb: breadcrumbs, reportError: reportErrorMock }));
vi.mock('../spray-telemetry', () => ({ trackSprayEvent: trackSprayEventMock }));

import {
  BIND_STAGE_DEADLINE_MS,
  NAVIGATION_SETTLE_MS,
  PostPublishStalledError,
  runPostPublishBind,
  type ActivationStage,
  type PostPublishBindInput,
} from '../post-publish-bind';

type ActivateHooks = Parameters<PostPublishBindInput['activate']>[0];

/** A promise and the handles to settle it from the test. */
function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const never = () => new Promise<never>(() => {});

/** An activation shaped like `activatePublishedSprayWall`: read, then bind if still live. */
function activation(readBoard: () => Promise<void>, bind: () => Promise<void>) {
  return async ({ onStage, isLive }: ActivateHooks) => {
    onStage('fetch_board');
    await readBoard();
    onStage('bind');
    if (!isLive()) return;
    await bind();
  };
}

function stagesSeen(): string[] {
  return breadcrumbs.mock.calls.map(([breadcrumb]) => breadcrumb.message);
}

beforeEach(() => {
  vi.useFakeTimers();
  breadcrumbs.mockClear();
  reportErrorMock.mockClear();
  trackSprayEventMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runPostPublishBind', () => {
  it('binds and leaves while the refresh is still hanging', async () => {
    const controller = new AbortController();
    const bind = vi.fn(async () => {});
    const navigate = vi.fn(() => controller.abort());
    const fallbackNavigate = vi.fn();

    const outcome = await runPostPublishBind({
      refresh: never,
      updateVisibility: null,
      activate: activation(async () => {}, bind),
      navigate,
      fallbackNavigate,
      signal: controller.signal,
    });

    expect(outcome).toBe('navigated');
    expect(bind).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(fallbackNavigate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failed refresh without failing the bind', async () => {
    const controller = new AbortController();
    const refreshError = new Error('refresh blew up');

    const outcome = await runPostPublishBind({
      refresh: () => Promise.reject(refreshError),
      updateVisibility: null,
      activate: activation(
        async () => {},
        async () => {},
      ),
      navigate: () => controller.abort(),
      fallbackNavigate: vi.fn(),
      signal: controller.signal,
    });

    expect(outcome).toBe('navigated');
    expect(reportErrorMock).toHaveBeenCalledWith(refreshError);
  });

  it('walks the stages in order', async () => {
    const controller = new AbortController();
    await runPostPublishBind({
      refresh: async () => {},
      updateVisibility: async () => {},
      activate: activation(
        async () => {},
        async () => {},
      ),
      navigate: () => controller.abort(),
      fallbackNavigate: vi.fn(),
      signal: controller.signal,
    });

    expect(stagesSeen()).toEqual(['refresh', 'visibility', 'fetch_board', 'bind', 'navigate']);
    for (const [breadcrumb] of breadcrumbs.mock.calls) expect(breadcrumb.category).toBe('spray-wall.bind');
  });

  it.each<[string, Partial<PostPublishBindInput>, string]>([
    [
      'visibility',
      {
        updateVisibility: never,
        activate: activation(
          async () => {},
          async () => {},
        ),
      },
      'visibility',
    ],
    ['fetch_board', { updateVisibility: null, activate: activation(never, async () => {}) }, 'fetch_board'],
    ['bind', { updateVisibility: null, activate: activation(async () => {}, never) }, 'bind'],
  ])('names %s when it hangs past the deadline', async (_label, stageInput, expectedStage) => {
    const controller = new AbortController();
    const navigate = vi.fn();
    const run = runPostPublishBind({
      refresh: async () => {},
      updateVisibility: null,
      activate: activation(
        async () => {},
        async () => {},
      ),
      navigate,
      fallbackNavigate: vi.fn(),
      signal: controller.signal,
      ...stageInput,
    });
    const settled = run.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(BIND_STAGE_DEADLINE_MS - 1);
    expect(reportErrorMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const error = await settled;
    expect(error).toBeInstanceOf(PostPublishStalledError);
    expect((error as PostPublishStalledError).stage).toBe(expectedStage);
    expect((error as PostPublishStalledError).elapsedMs).toBe(BIND_STAGE_DEADLINE_MS);
    expect(navigate).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { kind: 'spray_bind_stalled', stage: expectedStage } }),
    );
    expect(trackSprayEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ properties: { stage: expectedStage, elapsedMs: BIND_STAGE_DEADLINE_MS } }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot bind or navigate when a timed-out activation answers late', async () => {
    const controller = new AbortController();
    const boardRead = deferred();
    const bind = vi.fn(async () => {});
    const navigate = vi.fn();
    const settled = runPostPublishBind({
      refresh: async () => {},
      updateVisibility: null,
      activate: activation(() => boardRead.promise, bind),
      navigate,
      fallbackNavigate: vi.fn(),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(BIND_STAGE_DEADLINE_MS);
    expect(await settled).toBeInstanceOf(PostPublishStalledError);

    // The board read comes back long after the error was shown.
    boardRead.resolve();
    await vi.advanceTimersByTimeAsync(NAVIGATION_SETTLE_MS * 2);

    expect(bind).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back once when the screen is still there after navigating', async () => {
    const controller = new AbortController();
    const navigate = vi.fn();
    const fallbackNavigate = vi.fn();
    const run = runPostPublishBind({
      refresh: async () => {},
      updateVisibility: null,
      activate: activation(
        async () => {},
        async () => {},
      ),
      navigate,
      fallbackNavigate,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(NAVIGATION_SETTLE_MS - 1);
    expect(fallbackNavigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await run).toBe('fallback');
    expect(navigate).toHaveBeenCalledOnce();
    expect(fallbackNavigate).toHaveBeenCalledOnce();
    expect(stagesSeen()).toContain('navigated_noop');
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { kind: 'spray_bind_navigated_noop' } }),
    );
    expect(trackSprayEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ properties: { stage: 'navigate', elapsedMs: NAVIGATION_SETTLE_MS } }),
    );
  });

  it('stops quietly, timers cleared, when the screen unmounts mid-bind', async () => {
    const controller = new AbortController();
    const bindCall = deferred();
    const navigate = vi.fn();
    const stages: ActivationStage[] = [];
    const run = runPostPublishBind({
      refresh: async () => {},
      updateVisibility: null,
      activate: async ({ onStage }) => {
        onStage('fetch_board');
        stages.push('fetch_board');
        await bindCall.promise;
      },
      navigate,
      fallbackNavigate: vi.fn(),
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    expect(await run).toBe('abandoned');
    expect(vi.getTimerCount()).toBe(0);
    bindCall.resolve();
    await vi.advanceTimersByTimeAsync(BIND_STAGE_DEADLINE_MS);
    expect(navigate).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(stages).toEqual(['fetch_board']);
  });

  it('passes a stage failure through untouched', async () => {
    const controller = new AbortController();
    const readError = new Error('Published wall could not be loaded');
    await expect(
      runPostPublishBind({
        refresh: async () => {},
        updateVisibility: null,
        activate: activation(
          () => Promise.reject(readError),
          async () => {},
        ),
        navigate: vi.fn(),
        fallbackNavigate: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toBe(readError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
