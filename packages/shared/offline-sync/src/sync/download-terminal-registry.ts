// One terminal event per removal, shared between the two places that can emit it
// (issue #4406).
//
// A board removed mid-download can be torn down from either side of the same
// instant:
//
//  - the purge lands while `runBootstrapPhase` is working, and the phase reports
//    its own `aborted-wipe` Failed for the attempt it just abandoned; or
//  - the purge lands while the board-data loop is crawling, where the phase is
//    long finished and every exit is a silent `continue` — the gap this module
//    exists for. The teardown then emits the `abandoned-removed` terminal,
//    because it is the last code that can still see the durable `scope-started:`
//    marker before deleting it.
//
// Both can be true at once (a purge that lands mid-bootstrap runs the teardown
// milliseconds later), and two terminals for one Started would break the funnel
// invariant #4391 states. So the two agree through the teardown GENERATION: the
// epoch the teardown bumped is that teardown's identity, and a terminal is
// claimed against it exactly once.
//
// The generation is COMPOSITE — `${globalWipeEpoch}:${purgeEpoch(namespace)}` —
// because two different teardowns can end a download and they move different
// counters (issue #4452). `beginScopePurge` bumps only its namespace's epoch;
// `setSigningOut(true)` bumps only the global wipe epoch. Keying on the
// namespace epoch alone made a sign-out invisible to the registry: an
// `aborted-wipe` recorded earlier in the session, from an unrelated board
// removal, would still be the current generation and would falsely suppress the
// sign-out's terminal, and two sign-outs in one session would collide with each
// other.
//
// Keyed on a generation rather than a plain "already reported" flag on purpose.
// A scope collects `aborted-wipe` terminals routinely — every sibling size of a
// removed layout gets one, and none of those removals is its own — so a flag
// would let one stale report suppress a real abandonment months later. The
// generation makes the claim specific to the teardown in progress.
//
// Process-local, like every other purge-generation fact. A Started that survives
// a relaunch is covered by the durable markers instead: the teardown reads
// `scope-started:` / `scope-complete:` before its transaction, so a download
// abandoned in an earlier launch still reports exactly one terminal when the
// board is finally removed — and the launch backstop sweeps the de-listed ones.

import { getPurgeEpoch, getWipeEpoch } from '../mutation-queue/drainer';
import { purgeNamespaceForScopeKey } from '../offline-board-key';

/** scopeKey → the teardown generation a terminal event was last reported against. */
const terminalByScope = new Map<string, string>();

function teardownGeneration(namespace: string): string {
  return `${getWipeEpoch()}:${getPurgeEpoch(namespace)}`;
}

/**
 * A terminal event was just emitted for `scopeKey` by a torn-down cycle. Only
 * teardown-shaped reports (`aborted-wipe`) reach here: an ordinary failure is
 * this attempt's terminal but says nothing about a removal, and the download
 * itself is still owed one.
 */
export function noteScopeDownloadTerminal(scopeKey: string): void {
  const namespace = purgeNamespaceForScopeKey(scopeKey);
  // A malformed key belongs to no namespace we can name, so there is no
  // generation to record it against — and nothing will ever claim against it.
  if (namespace === undefined) return;
  terminalByScope.set(scopeKey, teardownGeneration(namespace));
}

/**
 * Claim the abandoned terminal for the teardown currently in progress — a board
 * removal or a sign-out. False when the cycle this teardown tore down already
 * reported one for the same generation.
 */
export function claimAbandonedDownloadTerminal(scopeKey: string, namespace: string): boolean {
  const generation = teardownGeneration(namespace);
  if (terminalByScope.get(scopeKey) === generation) return false;
  terminalByScope.set(scopeKey, generation);
  return true;
}

export function __resetDownloadTerminalRegistryForTests(): void {
  terminalByScope.clear();
}
