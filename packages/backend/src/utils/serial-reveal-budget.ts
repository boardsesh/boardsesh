import { redisClientManager } from '../redis/client';
import { logger } from './logger';
import { withRedisDeadline } from './redis-rate-limiter';

/**
 * The hourly budget of private boards one climber may have named to them over
 * Bluetooth (`observedBoardSerialMatches` request cards). See
 * docs/product/privacy.md ("What a serial tells a climber nearby").
 *
 * The budget counts distinct boards, not lookups: the picker looks a heard
 * serial up again on every open, and a climber standing at a friend's wall
 * must keep seeing the same card. A board already named this hour is named
 * again for free; a new one takes a slot while slots are left, and is held back
 * (the caller answers with the anonymous geometry stub) once they are gone.
 *
 * Fixed one-hour buckets aligned to the epoch, like `applyRateLimit`'s custom
 * windows, so the count resets on the hour.
 *
 * Redis holds one set of board uuids per climber per bucket, checked and
 * filled by one Lua script so two instances cannot both spend the last slot.
 * Without Redis (not connected, or a command that failed or took more than
 * 100 ms) each instance keeps its own set: during an outage a climber could be
 * named up to the budget once per backend instance. That is the one
 * approximation, and it only widens while Redis is down.
 */
export const SERIAL_REVEALS_PER_HOUR = 10;
export const SERIAL_REVEAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * KEYS[1] = the climber's set for this bucket
 * ARGV[1] = the budget, ARGV[2] = the set's lifetime in seconds,
 * ARGV[3..] = the boards to name, in the order they should get slots.
 * Returns the boards that may be named.
 */
const CLAIM_SCRIPT = `
local budget = tonumber(ARGV[1])
local named = {}
for index = 3, #ARGV do
  local board = ARGV[index]
  if redis.call('SISMEMBER', KEYS[1], board) == 1 then
    table.insert(named, board)
  elseif redis.call('SCARD', KEYS[1]) < budget then
    redis.call('SADD', KEYS[1], board)
    table.insert(named, board)
  end
end
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return named
`;

type MemoryBucket = { bucket: number; boards: Set<string> };
const memoryBuckets = new Map<string, MemoryBucket>();

function claimInMemory(userId: string, bucket: number, boardUuids: readonly string[]): Set<string> {
  const entry = memoryBuckets.get(userId);
  const current = entry && entry.bucket === bucket ? entry : { bucket, boards: new Set<string>() };
  memoryBuckets.set(userId, current);
  const named = new Set<string>();
  for (const boardUuid of boardUuids) {
    if (current.boards.has(boardUuid)) {
      named.add(boardUuid);
    } else if (current.boards.size < SERIAL_REVEALS_PER_HOUR) {
      current.boards.add(boardUuid);
      named.add(boardUuid);
    }
  }
  return named;
}

/**
 * Which of `boardUuids` this climber may be shown a request card for, spending
 * slots in the order given. Never throws: anything held back stays anonymous.
 */
export async function claimSerialReveals(userId: string, boardUuids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(boardUuids)];
  if (unique.length === 0) return new Set();
  const bucket = Math.floor(Date.now() / SERIAL_REVEAL_WINDOW_MS);
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const named = (await withRedisDeadline(
        publisher.eval(
          CLAIM_SCRIPT,
          1,
          `serial-reveal:${userId}:${bucket}`,
          String(SERIAL_REVEALS_PER_HOUR),
          String(Math.ceil(SERIAL_REVEAL_WINDOW_MS / 1000)),
          ...unique,
        ),
      )) as unknown;
      if (Array.isArray(named)) return new Set(named.filter((board): board is string => typeof board === 'string'));
    } catch (error) {
      logger.warn('[serial-reveal] Redis unavailable, counting on this instance:', (error as Error).message);
    }
  }
  return claimInMemory(userId, bucket, unique);
}

/** Tests only: forget every in-memory budget. */
export function resetSerialRevealBudgets(): void {
  memoryBuckets.clear();
}

// Drop budgets from past hours. Unref'd so a script importing a resolver can exit.
const budgetCleanup = setInterval(() => {
  const bucket = Math.floor(Date.now() / SERIAL_REVEAL_WINDOW_MS);
  for (const [userId, entry] of memoryBuckets) {
    if (entry.bucket < bucket) memoryBuckets.delete(userId);
  }
}, 60_000);
budgetCleanup.unref();
