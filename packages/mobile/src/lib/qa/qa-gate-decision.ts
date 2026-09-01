import { DEEP_LINK_SEGMENTS } from '../deep-link-segments';

/**
 * Top-level route groups the QA prompt must not cover. The onboarding /
 * deep-link set, plus `qa` itself so a re-render while the pick list or the
 * brief is already up can never push a second copy of it.
 */
export const QA_BLOCKED_TOP_SEGMENTS: ReadonlySet<string> = new Set([...DEEP_LINK_SEGMENTS, 'onboarding', 'qa']);

export type QaGateInput = {
  /** Auth + fonts resolved and the splash hidden. */
  ready: boolean;
  /** `undefined` while the profile query is in flight — never treat that as false. */
  isTester: boolean | undefined;
  /**
   * The signed-in account the persisted markers belong to. `undefined` while the
   * profile query is in flight — and a marker whose owner is unknown cannot be
   * read, since the settings store is device-wide and shared between testers.
   */
  userId: string | undefined;
  /** This binary can surf OTA branches at all (fingerprint-bound headers present). */
  surfingBuild: boolean;
  /**
   * The root layout has published its answer AND xprem's one-time
   * legacy-override migration has settled, so a reload is not pending. False
   * both while that migration runs and before anything has been published at
   * all — `wait` covers each.
   */
  surfingReady: boolean;
  screenshotMode: boolean;
  /** The cold start came in through a deep link, so the user has intent elsewhere. */
  launchedByDeepLink: boolean;
  topSegment: string | undefined;
  /** `undefined` while the persisted flag is still being read. */
  onboardingSeen: boolean | undefined;
  /** The `pr-<n>` branch this bundle is running, or null on production. */
  runningPrNumber: number | null;
  /** How many `pr-<n>` branches this build could load; null = not looked up / unknown. */
  prBranchCount: number | null;
  briefSeenKey: string | null;
  verdictSubmittedKey: string | null;
  /** `qaSessionKey(userId, branch, updateId)` for the running bundle; null on production. */
  currentKey: string | null;
};

/**
 * `wait` — not enough is known yet; ask again when the inputs change.
 * `none` — do nothing this launch.
 * `pick` — offer the list of PR previews (we are on production).
 * `brief` — show what to test (we are already running a `pr-<n>` bundle).
 */
export type QaGateDecision = 'wait' | 'none' | 'pick' | 'brief';

/**
 * The whole launch-time policy for the crowdsourced-QA prompt, as one pure
 * function so every branch is unit-testable without a renderer.
 *
 * The gate calls this twice. The first call supplies optimistic stand-ins for
 * the values that are only readable asynchronously (`onboardingSeen: true`,
 * `launchedByDeepLink: false`, `prBranchCount: 1`), which is what makes a
 * non-`wait` first answer mean "the cheap synchronous reasons to stop don't
 * apply — go do the async reads". The second call passes the real values and
 * yields the action actually taken. Feeding the optimistic input is the caller's
 * job precisely so this function stays a single, total description of the rule.
 */
export function decideQaGate(input: QaGateInput): QaGateDecision {
  // Nothing is decidable until the app has settled AND the two "unknown means
  // unknown" reads have landed. `isTester` is undefined on a cold offline start
  // (the profile is network-only), and treating that as "not a tester" would
  // silently disable QA for everyone with no signal at launch.
  if (!input.ready) return 'wait';
  if (input.isTester === undefined) return 'wait';
  // Without the account there is no way to tell "this tester already signed this
  // bundle off" from "someone else on this device did". `wait`, not "unseen":
  // guessing wrong re-briefs tester A for tester B's work, or worse, silences B.
  if (input.userId === undefined) return 'wait';
  if (input.onboardingSeen === undefined) return 'wait';
  // A surfing-capable binary runs a one-time migration that ends in
  // Updates.reloadAsync(). Prompting before it settles would push a route the
  // reload immediately throws away.
  //
  // Waiting on `surfingReady` ALONE, not on `surfingBuild && !surfingReady`:
  // `{ surfingBuild: false, surfingReady: false }` is also the state of the
  // store BEFORE the root layout has published anything, and resolving that to
  // `none` is a silent kill switch — the caller marks the session decided on a
  // `none` and never asks again, so one reordering of the mount effects would
  // switch QA off with nothing said anywhere. A build that cannot surf publishes
  // `{ false, true }` from its very first effect (`migrationComplete` starts at
  // `!branchSurfingBuild`), so "not ready" only ever means "nobody has answered
  // yet" or "the migration is still running" — and both are `wait`.
  if (!input.surfingReady) return 'wait';

  if (input.screenshotMode) return 'none';
  if (!input.isTester) return 'none';
  // Not a build that can load a branch: the prompt would offer something the
  // binary cannot act on.
  if (!input.surfingBuild) return 'none';
  if (input.launchedByDeepLink) return 'none';
  if (!input.onboardingSeen) return 'none';
  if (input.topSegment !== undefined && QA_BLOCKED_TOP_SEGMENTS.has(input.topSegment)) return 'none';

  if (input.runningPrNumber !== null) {
    // Already on a preview. Show the brief once per branch+bundle: seeing it
    // again after every backgrounding would be noise, and after a verdict the
    // tester is done with this revision entirely.
    if (input.currentKey !== null && input.briefSeenKey === input.currentKey) return 'none';
    if (input.currentKey !== null && input.verdictSubmittedKey === input.currentKey) return 'none';
    return 'brief';
  }

  // On production. A null count is "we never found out" — an unreachable update
  // server, or surfing switched off for this channel — and an empty list is
  // "nothing to test". Both mean no prompt.
  if (input.prBranchCount === null) return 'none';
  return input.prBranchCount > 0 ? 'pick' : 'none';
}
