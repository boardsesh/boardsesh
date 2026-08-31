import AuroraClimbingClient from '../api/aurora-client';
import { fetchAuroraGymUser, type AuroraGymUser } from '../api/gym-walls-api';
import type { AuroraPin } from '../api/pins-api';
import { isAuroraRequestError, isTransientAuroraError } from '../api/errors';
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
  // A plain record, not NodeJS.ProcessEnv: this reads two string keys and
  // nothing else, and the repo's ProcessEnv requires NODE_ENV, which would make
  // every caller (and test) construct a fuller object than the function uses.
  env: Record<string, string | undefined> = process.env,
): { username: string; password: string } | undefined {
  const suffix = board.toUpperCase();
  const username = env[`AURORA_LOCATION_USERNAME_${suffix}`];
  const password = env[`AURORA_LOCATION_PASSWORD_${suffix}`];
  if (!username || !password) return undefined;
  return { username, password };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Aurora answers a rejected session with 422, which `errors.ts` maps to
 * `invalid_credentials`. Indistinguishable from genuinely wrong credentials at
 * the request level — the difference is that we already logged in successfully
 * once, so the caller only treats it as an expiry mid-crawl.
 */
function isExpiredSessionError(error: unknown): boolean {
  return isAuroraRequestError(error) && error.code === 'invalid_credentials';
}

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
  env?: Record<string, string | undefined>;
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

  const signIn = async (): Promise<string> => {
    const login = await client.signIn(credentials.username, credentials.password);
    // `LoginResponse.token` is optional in the shared type (the API answers in
    // two shapes), but signIn normalises both before returning; treat a missing
    // token as a failed login rather than crawling unauthenticated.
    if (!login.token) throw new Error('Aurora login returned no session token');
    return login.token;
  };

  let token: string;
  try {
    token = await signIn();
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

  // A full crawl runs for hours, so the session very plausibly expires part-way
  // through. Left unhandled, every gym after the expiry would quietly fall back
  // to the guessed config and look identical to "this gym has no walls". Aurora
  // reports a rejected session as 422 -> `invalid_credentials`, which is
  // non-transient, so it is caught here rather than by the retry loop: sign in
  // again and retry that gym. Once per gym, so genuinely bad credentials can't
  // spin.
  // Set when a re-login fails outright — wrong credentials, or Aurora's auth
  // endpoint down. Without it every remaining gym in a multi-thousand crawl
  // would still pay for a doomed lookup AND a doomed re-auth, doubling the
  // request count for the rest of a run that can no longer succeed.
  let sessionPermanentlyBroken = false;
  const refreshExpiredSession = async (): Promise<boolean> => {
    if (sessionPermanentlyBroken) return false;
    try {
      token = await signIn();
      args.log?.(`[aurora-locations] ${args.board}: session expired mid-crawl, signed in again`);
      return true;
    } catch (error) {
      sessionPermanentlyBroken = true;
      args.log?.(
        `[aurora-locations] ${args.board}: session expired and re-login failed, remaining gyms use default configs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };

  // `nextRequestAtMs` is closure state shared by every call, which paces a
  // SEQUENTIAL caller correctly and nothing else: two overlapping calls can both
  // read it before either writes, see no wait, and fire back to back. The only
  // caller (`syncAuroraBoardLocations`) awaits each gym in turn precisely
  // because Aurora rate-limits per board — keep it that way rather than adding a
  // queue here.
  let nextRequestAtMs = 0;
  return async (pin: AuroraPin): Promise<AuroraGymUser | undefined> => {
    // Once the session is unrecoverable there is nothing left to try, so skip
    // straight to the default-config fallback rather than spending a request
    // per remaining gym.
    if (sessionPermanentlyBroken) return undefined;
    let sessionRefreshedForThisGym = false;
    // A successful re-auth must not consume the gym's last attempt: refreshing
    // on the final pass used to `continue` straight past the loop condition, so
    // the fresh session was thrown away unused and the gym fell back silently.
    // The refresh buys one extra pass, once.
    let attemptBudget = MAX_ATTEMPTS_PER_GYM;
    for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
      const waitMs = nextRequestAtMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      nextRequestAtMs = Date.now() + MIN_REQUEST_INTERVAL_MS;

      try {
        return await fetchAuroraGymUser(args.board, pin.id, token);
      } catch (error) {
        if (isExpiredSessionError(error) && !sessionRefreshedForThisGym) {
          sessionRefreshedForThisGym = true;
          if (await refreshExpiredSession()) {
            attemptBudget += 1;
            continue;
          }
          return undefined;
        }
        if (attempt >= attemptBudget || !isTransientAuroraError(error)) {
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
  };
}
