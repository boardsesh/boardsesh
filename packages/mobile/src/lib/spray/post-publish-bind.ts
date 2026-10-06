// The half of the add-a-wall publish that runs AFTER the version has landed:
// register the published generation, re-state the visibility, bind the wall as
// the active board, and leave.
//
// Pulled out of `SprayWallWizardScreen` because this is where TestFlight found
// the flow parked forever on "Setting your wall up…": the wall was published
// and in Your boards, but never bound. Nothing in the chain is provably
// infinite on its own, so instead of guessing which await stalled, every one of
// them now has a ceiling, a breadcrumb that names it, and a way out:
//
//  - the refresh is fire-and-forget. It is an `invalidateQueries`, and with the
//    app's `offlineFirst` network mode a live subscriber's refetch can PAUSE
//    until the connectivity store says online again — which is not a thing the
//    bind should wait on;
//  - the visibility write and the activation each get `BIND_STAGE_DEADLINE_MS`.
//    Past it the run throws `PostPublishStalledError` naming the stage it was
//    waiting on, and the wizard turns that into an error with Try again (the
//    `published` latch keeps the retry from re-publishing);
//  - a run that timed out, or whose screen unmounted, is dead: its late answer
//    cannot start a bind or navigate over whatever the climber is doing now
//    (a board write already in flight when the deadline hit may still land);
//  - and a navigation that is dispatched but does not land is noticed
//    (`NAVIGATION_SETTLE_MS`) and followed once by `fallbackNavigate`, which
//    takes a different road out.
//
// I/O is injected, so every one of those cases is a fake-timer unit test rather
// than something only a phone on a bad connection can reach.

import { sprayWallBindStalled, type SprayBindStage } from '@boardsesh/analytics';
import { addErrorBreadcrumb, reportError } from '../error-reporting';
import { trackSprayEvent } from './spray-telemetry';

export type { SprayBindStage };

/**
 * Where the run is, in order. `refresh` is started and never waited on; the
 * rest are what the run is waiting on while it sits in them. `navigated_noop`
 * is the extra breadcrumb a navigation that did not land leaves.
 */
export type PostPublishStage = 'refresh' | 'visibility' | 'fetch_board' | 'bind' | 'navigate' | 'navigated_noop';

/** The stages `activatePublishedSprayWall` reports from inside itself. */
export type ActivationStage = Extract<PostPublishStage, 'fetch_board' | 'bind'>;

/**
 * How long one waited-on stage may take.
 *
 * Longer than the GraphQL client's own 20 s request deadline
 * (`INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS`), so a request that is merely slow
 * fails with the client's own error first and this only fires on a wait the
 * client cannot see — a paused query, a storage queue, a promise that never
 * settles.
 */
export const BIND_STAGE_DEADLINE_MS = 30_000;

/**
 * How long after navigating the screen may still be mounted before the
 * navigation is treated as a no-op.
 *
 * A dismiss of the Boards modal unmounts the wizard within one native
 * transition; this allows several of those on a slow phone and is still short
 * enough that a climber has not yet decided the app is stuck.
 */
export const NAVIGATION_SETTLE_MS = 1_500;

/**
 * How long the wizard's `done` spinner runs before it also offers a way out by
 * hand. A bind that works is a visibility write, one board read and a storage
 * write, and normally dismisses well inside this; the button is for the run
 * that does not, so it never flashes up over one that does.
 */
export const DONE_EXIT_OFFER_MS = 5_000;

/** One waited-on stage ran past `BIND_STAGE_DEADLINE_MS`. */
export class PostPublishStalledError extends Error {
  readonly stage: SprayBindStage;
  readonly elapsedMs: number;

  constructor(stage: SprayBindStage, elapsedMs: number) {
    // Low-cardinality on purpose: Sentry groups on it, and the stage is the
    // only thing that differs between two of these.
    super(`Spray wall bind stalled at ${stage}`);
    this.name = 'PostPublishStalledError';
    this.stage = stage;
    this.elapsedMs = elapsedMs;
  }
}

export type PostPublishBindInput = {
  /** Register the published generation. Started, never awaited. */
  refresh: () => Promise<unknown>;
  /** Re-state the chosen visibility, or null when this run has none to state. */
  updateVisibility: (() => Promise<unknown>) | null;
  /**
   * Fetch the published board and bind it. Must report `fetch_board` and `bind`
   * through `onStage`, and must not bind once `isLive()` is false — the run
   * that started it has timed out or been abandoned by then.
   */
  activate: (hooks: { onStage: (stage: ActivationStage) => void; isLive: () => boolean }) => Promise<void>;
  /** Leave the flow. Called once the bind has landed. */
  navigate: () => void;
  /**
   * Leave by a DIFFERENT road when `navigate` did not land. Re-sending the same
   * navigation would fail for the same reason the first one did.
   */
  fallbackNavigate: () => void;
  /**
   * Aborted when the screen unmounts or a newer attempt starts. Unmounting is
   * also how a navigation that DID land is recognised, so the settle check reads
   * an abort as success.
   */
  signal: AbortSignal;
  deadlineMs?: number;
  settleMs?: number;
  now?: () => number;
};

/**
 * `navigated` — the bind landed and the screen went away.
 * `fallback`  — the bind landed, the first navigation did not, the fallback ran.
 * `abandoned` — the screen went away (or a newer attempt began) before the end.
 */
export type PostPublishBindOutcome = 'navigated' | 'fallback' | 'abandoned';

/**
 * Run the post-publish chain. Resolves with how it ended; rejects with
 * `PostPublishStalledError` on a deadline, or with whatever a stage threw.
 * A run that has been abandoned never rejects: nobody is left to show it.
 */
export async function runPostPublishBind({
  refresh,
  updateVisibility,
  activate,
  navigate,
  fallbackNavigate,
  signal,
  deadlineMs = BIND_STAGE_DEADLINE_MS,
  settleMs = NAVIGATION_SETTLE_MS,
  now = Date.now,
}: PostPublishBindInput): Promise<PostPublishBindOutcome> {
  const startedAt = now();
  let stage: PostPublishStage = 'refresh';
  let stalled = false;
  const isLive = () => !stalled && !signal.aborted;

  const enter = (next: PostPublishStage) => {
    stage = next;
    addErrorBreadcrumb({
      category: 'spray-wall.bind',
      message: next,
      level: next === 'navigated_noop' ? 'warning' : 'info',
      data: { elapsedMs: now() - startedAt },
    });
  };

  /** The deadline's verdict: mark the run dead, report where it sat, and say so. */
  const stalledError = (): Error => {
    stalled = true;
    // `refresh` is never waited on and `navigate` is synchronous, so the run is
    // in one of the three waited-on stages — or still before the activation's
    // first report, which is its board read.
    const stalledStage: SprayBindStage = stage === 'visibility' || stage === 'bind' ? stage : 'fetch_board';
    const elapsedMs = now() - startedAt;
    const error = new PostPublishStalledError(stalledStage, elapsedMs);
    reportError(error, {
      level: 'warning',
      tags: { kind: 'spray_bind_stalled', stage: stalledStage },
      extra: { elapsedMs },
      fingerprint: ['spray-bind-stalled', stalledStage],
    });
    trackSprayEvent(sprayWallBindStalled({ stage: stalledStage, elapsedMs }));
    return error;
  };

  try {
    enter('refresh');
    void refresh().catch((error: unknown) => reportError(error));

    if (updateVisibility) {
      enter('visibility');
      await withDeadline(updateVisibility(), deadlineMs, stalledError, signal);
    }

    // `activate` names its own two stages; the deadline covers both together.
    await withDeadline(activate({ onStage: enter, isLive }), deadlineMs, stalledError, signal);
  } catch (error) {
    if (signal.aborted) return 'abandoned';
    throw error;
  }

  if (!isLive()) return 'abandoned';
  enter('navigate');
  navigate();

  const unmounted = await abortedWithin(signal, settleMs);
  if (unmounted) return 'navigated';

  // Still here: the dismiss was dispatched and nothing happened. Said loudly,
  // because the climber is looking at a spinner over a wall that is bound.
  enter('navigated_noop');
  const elapsedMs = now() - startedAt;
  reportError(new Error('Spray wall navigation did not land'), {
    level: 'warning',
    tags: { kind: 'spray_bind_navigated_noop' },
    extra: { elapsedMs },
    fingerprint: ['spray-bind-navigated-noop'],
  });
  trackSprayEvent(sprayWallBindStalled({ stage: 'navigate', elapsedMs }));
  fallbackNavigate();
  return 'fallback';
}

/**
 * Wait on `work`, but never past `ms` and never past an abort of `signal`.
 *
 * Past the deadline it rejects with whatever `onTimeout` returns; on an abort,
 * with an `AbortError`. The timer and the abort listener are both removed the
 * moment it settles, so work that finished leaves nothing behind to fire later.
 * `work` itself is not cancelled — its late answer is simply not listened to.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abandonedError());
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abandonedError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(onTimeout());
    }, ms);
    signal?.addEventListener('abort', onAbort);
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abandonedError(): Error {
  const error = new Error('Spray wall bind abandoned');
  error.name = 'AbortError';
  return error;
}

/** Resolves true when `signal` aborts within `ms`, false when the time runs out first. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    // No `{ once: true }`: React Native's AbortSignal is a shim, and removing
    // the listener by hand works on every version of it.
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}
