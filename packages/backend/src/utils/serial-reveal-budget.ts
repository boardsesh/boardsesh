import { redisClientManager } from '../redis/client';
import { logger } from './logger';
import { withRedisDeadline } from './redis-rate-limiter';

/**
 * How many private boards one climber may have named to them over Bluetooth
 * (`observedBoardSerialMatches` request cards). See docs/product/privacy.md
 * ("What a serial tells a climber nearby").
 *
 * Three caps, all counting distinct boards, not lookups: the picker looks a
 * heard serial up again on every open, and a climber standing at a friend's
 * wall must keep seeing the same card. A board already counted in a window is
 * named again without spending that window's slot; a board that needs a slot
 * in any window that has none left is held back (the caller answers with the
 * anonymous geometry stub).
 *
 * - 10 an hour: fixed one-hour buckets aligned to the epoch, like
 *   `applyRateLimit`'s custom windows, so the count resets on the hour.
 * - 15 a day: fixed UTC calendar days, resetting at 00:00 UTC.
 * - 40 in any 30 days: a rolling window. Each board is kept with the last time
 *   it was named and drops out 30 days after that, so the 41st distinct board
 *   waits until one of the 40 has gone unnamed for 30 days.
 *
 * Redis only, and fail closed: one Lua script checks and fills all three so two
 * instances cannot both spend the last slot. When Redis is not connected, the
 * command fails, or it takes more than 100 ms, nothing is named. A command that
 * timed out may still run in Redis afterwards and count boards the climber was
 * never shown, so an outage can only use slots up early, never name more than
 * the caps.
 */
export const SERIAL_REVEALS_PER_HOUR = 10;
export const SERIAL_REVEALS_PER_DAY = 15;
export const SERIAL_REVEALS_PER_30_DAYS = 40;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ROLLING_WINDOW_MS = 30 * DAY_MS;

/**
 * KEYS[1] = the climber's set for this hour, KEYS[2] = for this UTC day,
 * KEYS[3] = their sorted set of boards scored by when each was last named.
 * ARGV[1] = now in ms, ARGV[2..4] = the hourly, daily and 30-day budgets,
 * ARGV[5..6] = the hour and day sets' lifetimes in seconds,
 * ARGV[7] = the rolling window in ms,
 * ARGV[8..] = the boards to name, in the order they should get slots.
 * Returns the boards that may be named.
 */
const CLAIM_SCRIPT = `
local now = tonumber(ARGV[1])
local hourBudget = tonumber(ARGV[2])
local dayBudget = tonumber(ARGV[3])
local rollingBudget = tonumber(ARGV[4])
local rollingMs = tonumber(ARGV[7])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - rollingMs)
local named = {}
for index = 8, #ARGV do
  local board = ARGV[index]
  local hourRoom = redis.call('SISMEMBER', KEYS[1], board) == 1 or redis.call('SCARD', KEYS[1]) < hourBudget
  local dayRoom = redis.call('SISMEMBER', KEYS[2], board) == 1 or redis.call('SCARD', KEYS[2]) < dayBudget
  local rollingRoom = redis.call('ZSCORE', KEYS[3], board) or redis.call('ZCARD', KEYS[3]) < rollingBudget
  if hourRoom and dayRoom and rollingRoom then
    redis.call('SADD', KEYS[1], board)
    redis.call('SADD', KEYS[2], board)
    redis.call('ZADD', KEYS[3], now, board)
    table.insert(named, board)
  end
end
if redis.call('TTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
if redis.call('TTL', KEYS[2]) == -1 then redis.call('EXPIRE', KEYS[2], ARGV[6]) end
redis.call('PEXPIRE', KEYS[3], rollingMs)
return named
`;

/**
 * Which of `boardUuids` this climber may be shown a request card for, spending
 * slots in the order given. Never throws: anything held back, and everything
 * while Redis is unavailable, stays anonymous.
 */
export async function claimSerialReveals(userId: string, boardUuids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(boardUuids)];
  if (unique.length === 0) return new Set();
  if (!redisClientManager.isRedisConnected()) {
    logger.warn('[serial-reveal] Redis not connected, naming no boards');
    return new Set();
  }
  const now = Date.now();
  try {
    const { publisher } = redisClientManager.getClients();
    const named = (await withRedisDeadline(
      publisher.eval(
        CLAIM_SCRIPT,
        3,
        `serial-reveal:${userId}:hour:${Math.floor(now / HOUR_MS)}`,
        `serial-reveal:${userId}:day:${Math.floor(now / DAY_MS)}`,
        `serial-reveal:${userId}:rolling`,
        String(now),
        String(SERIAL_REVEALS_PER_HOUR),
        String(SERIAL_REVEALS_PER_DAY),
        String(SERIAL_REVEALS_PER_30_DAYS),
        String(HOUR_MS / 1000),
        // Two days, so the set outlives its own day whatever hour it was made.
        String((2 * DAY_MS) / 1000),
        String(ROLLING_WINDOW_MS),
        ...unique,
      ),
    )) as unknown;
    if (Array.isArray(named)) return new Set(named.filter((board): board is string => typeof board === 'string'));
    logger.warn('[serial-reveal] Unexpected Redis reply, naming no boards');
  } catch (error) {
    logger.warn('[serial-reveal] Redis unavailable, naming no boards:', (error as Error).message);
  }
  return new Set();
}
