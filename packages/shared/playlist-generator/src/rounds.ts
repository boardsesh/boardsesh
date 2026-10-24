// Rounds (#5380): a 4x4 climbs the same climbs several times over. The plan has
// one slot per climb of a round; the rounds are queue copies of those climbs,
// each under its own queue-item uuid, and the run stores every copy's round.
// Pure TS.

/** Where the current climb sits among the rounds of its stage. Every count covers queued climbs only. */
export type WorkoutRunRoundPosition = {
  /** 1-based rank of the climb's round among the stage's rounds that still have queued climbs. */
  round: number;
  roundCount: number;
  /** 1-based position, in queue order, among the queued climbs of that round. */
  positionInRound: number;
  roundSize: number;
};

/** A stored round number: a whole number from 1. */
export const isRoundNumber = (candidate: unknown): candidate is number =>
  typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 1;

/**
 * The items for `rounds` rounds, round-major: A B C D, A B C D, and so on.
 * Round 1 keeps the items as given (their uuids included); every later round
 * gets `copyForRound(item, round)`, which must mint a fresh queue-item uuid.
 * Fewer than one round, or a broken count, gives round 1 alone.
 */
export function expandRounds<Item extends { uuid: string }>(
  items: readonly Item[],
  rounds: number,
  copyForRound: (item: Item, round: number) => Item,
): Array<{ item: Item; round: number }> {
  const roundCount = Number.isFinite(rounds) ? Math.max(1, Math.floor(rounds)) : 1;
  const expanded: Array<{ item: Item; round: number }> = [];
  for (let round = 1; round <= roundCount; round++) {
    for (const item of items) {
      expanded.push({ item: round === 1 ? item : copyForRound(item, round), round });
    }
  }
  return expanded;
}

/**
 * The current climb's round position, from its stage's queued uuids in queue
 * order and the stage's stored rounds. Rounds rank by their stored number, so
 * a reordered queue still reads "Round 2" for a round-2 climb; a round with no
 * queued climbs left is skipped. Null when the current climb has no round.
 */
export function locateRound(
  queuedUuids: readonly string[],
  roundByUuid: Readonly<Record<string, number>>,
  currentUuid: string,
): WorkoutRunRoundPosition | null {
  const roundOf = (uuid: string): number | null => {
    if (!Object.hasOwn(roundByUuid, uuid)) return null;
    const round = roundByUuid[uuid];
    return isRoundNumber(round) ? round : null;
  };
  const currentRound = roundOf(currentUuid);
  if (currentRound === null) return null;

  const queuedRounds = new Set<number>();
  let roundSize = 0;
  let positionInRound = 0;
  for (const uuid of queuedUuids) {
    const round = roundOf(uuid);
    if (round === null) continue;
    queuedRounds.add(round);
    if (round !== currentRound) continue;
    roundSize += 1;
    if (uuid === currentUuid) positionInRound = roundSize;
  }
  // The current climb must itself be queued for a position to mean anything.
  if (positionInRound === 0) return null;

  const rankedRounds = [...queuedRounds].sort((left, right) => left - right);
  return {
    round: rankedRounds.indexOf(currentRound) + 1,
    roundCount: rankedRounds.length,
    positionInRound,
    roundSize,
  };
}
