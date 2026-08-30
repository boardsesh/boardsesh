import AuroraClimbingClient from '../api/aurora-client';
import { fetchAuroraGymUser, type AuroraGymUser } from '../api/gym-walls-api';
import type { AuroraPin } from '../api/pins-api';
import { isTransientAuroraError } from '../api/errors';
import type { AuroraLocationBoardName } from './locations-sync';

/**
 * Aurora rate-limits per board app. Their published ceiling is 30 requests a
 * minute, so pace at one request every 2.1s and leave a little headroom — a
 * location crawl is a background chore, not something anyone waits on.
 */
const MIN_REQUEST_INTERVAL_MS = 2100;

/** Give up on a gym after this many transient failures and move on. */
const MAX_ATTEMPTS_PER_GYM = 3;

/**
 * Env credentials for the location crawl, per board app (Aurora accounts don't
 * span apps). Deliberately a DEDICATED account rather than one of the rotating
 * user credentials in `board_credentials`: a crawl of several thousand gyms
 * would spend a real climber's rate budget and, on failure, mark their
 * credential as failing in the sync ledger.
 */
export function auroraLocationCredentials(
  board: AuroraLocationBoardName,
  env: NodeJS.ProcessEnv = process.env,
): { username: string; password: string } | undefined {
  const suffix = board.toUpperCase();
  const username = env[`AURORA_LOCATION_USERNAME_${suffix}`];
  const password = env[`AURORA_LOCATION_PASSWORD_${suffix}`];
  if (!username || !password) return undefined;
  return { username, password };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the `fetchGymUser` function the location sync uses to read a gym's real
 * walls, or `undefined` when this board has no configured credentials — in
 * which case every gym falls back to the guessed default config, exactly as
 * before this existed. Dev and CI therefore need no secrets.
 *
 * A single gym's failure never aborts the crawl: transient errors are retried a
 * few times, then that gym is skipped and reported. One unreachable gym must
 * not cost us the other few thousand.
 */
export async function createAuroraGymUserFetcher(args: {
  board: AuroraLocationBoardName;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): Promise<((pin: AuroraPin) => Promise<AuroraGymUser | undefined>) | undefined> {
  const credentials = auroraLocationCredentials(args.board, args.env);
  if (!credentials) {
    args.log?.(
      `[aurora-locations] ${args.board}: no AURORA_LOCATION_USERNAME_${args.board.toUpperCase()} configured; using default board configs`,
    );
    return undefined;
  }

  const client = new AuroraClimbingClient({ boardName: args.board });
  let token: string;
  try {
    const login = await client.signIn(credentials.username, credentials.password);
    // `LoginResponse.token` is optional in the shared type (the API answers in
    // two shapes), but signIn normalises both before returning; treat a missing
    // token as a failed login rather than crawling unauthenticated.
    if (!login.token) throw new Error('Aurora login returned no session token');
    token = login.token;
  } catch (error) {
    // A bad password must not fail the whole location sync — the map is more
    // useful with guessed configs than absent.
    args.log?.(
      `[aurora-locations] ${args.board}: location-crawl login failed, using default board configs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }

  let nextRequestAtMs = 0;
  return async (pin: AuroraPin): Promise<AuroraGymUser | undefined> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_GYM; attempt += 1) {
      const waitMs = nextRequestAtMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      nextRequestAtMs = Date.now() + MIN_REQUEST_INTERVAL_MS;

      try {
        return await fetchAuroraGymUser(args.board, pin.id, token);
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS_PER_GYM || !isTransientAuroraError(error)) {
          args.log?.(
            `[aurora-locations] ${args.board}: could not read gym ${pin.id} (${pin.name ?? 'unnamed'}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
        // Back off further on a retry — a 429 means the pacing above was not
        // enough for whatever else is talking to Aurora right now.
        nextRequestAtMs = Date.now() + MIN_REQUEST_INTERVAL_MS * (attempt + 1);
      }
    }
    return undefined;
  };
}
