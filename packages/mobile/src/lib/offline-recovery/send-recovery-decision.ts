import { DEEP_LINK_SEGMENTS } from '../deep-link-segments';

/**
 * Top-level route groups the recovery notice must not cover. The onboarding /
 * deep-link set, plus `send-recovery` itself so a re-render while the notice is
 * already up can never push a second copy of it.
 */
export const SEND_RECOVERY_BLOCKED_TOP_SEGMENTS: ReadonlySet<string> = new Set([
  ...DEEP_LINK_SEGMENTS,
  'onboarding',
  'send-recovery',
]);

export type SendRecoveryInput = {
  /** Auth + fonts resolved and the splash hidden. */
  ready: boolean;
  /**
   * The migration that recovers the sends has run. Until it has, "no notice" and
   * "not asked yet" are the same value, and treating that as "nothing to say"
   * would silently drop the notice on a contended launch.
   */
  schemaReady: boolean;
  /**
   * How many sends the one-time recovery put back, or `null` for "none owed".
   * `undefined` while the read is still in flight — never treat that as none.
   */
  recoveredCount: number | null | undefined;
  screenshotMode: boolean;
  /** The cold start came in through a deep link, so the climber has intent elsewhere. */
  launchedByDeepLink: boolean;
  topSegment: string | undefined;
  /** `undefined` while the persisted flag is still being read. */
  onboardingSeen: boolean | undefined;
};

/**
 * `wait` — not enough is known yet; ask again when the inputs change.
 * `none` — say nothing this launch.
 * `show` — tell the climber what came back.
 */
export type SendRecoveryDecision = 'wait' | 'none' | 'show';

/**
 * The whole launch-time policy for the #5335 recovery notice, as one pure
 * function so every branch is unit-testable without a renderer.
 *
 * Same two-pass shape as `decideQaGate`: the gate calls this once with
 * optimistic stand-ins for the values only readable asynchronously, and again
 * with the real ones. A non-`wait` first answer means "none of the cheap
 * synchronous reasons to stop apply — go pay for the reads".
 *
 * The count is the only reason this ever fires. Zero recovered sends is not a
 * quieter notice, it is no notice: nothing happened to that climber.
 */
export function decideSendRecovery(input: SendRecoveryInput): SendRecoveryDecision {
  if (!input.ready) return 'wait';
  // The recovery runs inside the schema migration, so before that lands there is
  // nothing to read and no answer to give.
  if (!input.schemaReady) return 'wait';
  if (input.recoveredCount === undefined) return 'wait';
  if (input.onboardingSeen === undefined) return 'wait';

  if (input.screenshotMode) return 'none';
  if (input.recoveredCount === null || input.recoveredCount < 1) return 'none';
  if (input.launchedByDeepLink) return 'none';
  // The first-run walkthrough always wins a cold start. `none`, not `wait`: the
  // notice is durable in the database, so skipping this launch costs nothing and
  // the climber gets told on the next one — whereas waiting would hold a session
  // guard open behind a flag that only flips after a whole tour.
  if (!input.onboardingSeen) return 'none';
  if (input.topSegment !== undefined && SEND_RECOVERY_BLOCKED_TOP_SEGMENTS.has(input.topSegment)) return 'none';

  return 'show';
}
