import type { PostHog } from 'posthog-react-native';
import { getPostHogClient } from './posthog-client';

/**
 * The `gym_uuid` / `gym_name` super properties: WHICH physical venue the
 * climber's active board belongs to, stamped onto every subsequent event.
 *
 * Nothing in the climbing telemetry carried a gym before this. Every climb
 * event ships `boardName` (the board TYPE — kilter/tension), `layoutId` and
 * `sizeId`, which describe the catalogue config, not the wall; `Board Created`
 * ships `hasGym` as a bare boolean. The gym-funnel events do carry `gymUuid`,
 * but they are www-only (directory, QR landing, claim flow) and never fire from
 * the app. So "which gyms have the most Boardsesh climbers" — and the whole
 * per-venue slice of product health — was unanswerable from any existing event.
 *
 * Registered as SUPER properties rather than per-event props on purpose: the
 * question is not only "who sends climbs here" but "does Bluetooth work here",
 * and `Bluetooth Connection Failed` fires from a hook that holds no board
 * entity. One registration on active-board change reaches every event instead
 * of threading a prop into fourteen call sites and still missing the BLE ones.
 *
 * It lives in its own module (rather than an inline `registerSuperProperties`
 * call) because it has to survive `analytics.reset()`: PostHog's reset clears
 * every registered super property, and the active board does not change on
 * sign-out, so the effect that registered it will not re-run. Remembering the
 * last value here is what lets `reset()` put it straight back — the same reason
 * `connectivity` (#4317) and `offline_engine_state` (#4312) are re-registered.
 */
export type ActiveGym = { uuid: string; name: string };

export const GYM_UUID_SUPER_PROPERTY = 'gym_uuid';
export const GYM_NAME_SUPER_PROPERTY = 'gym_name';

type GymRegisterClient = Pick<PostHog, 'register' | 'unregister'>;

// `undefined` = nothing has been published this launch yet (do not touch the
// client). `null` = the active board has no gym, which must CLEAR the property
// rather than leave the previous gym stamped — otherwise a climber who switches
// from a gym wall to their home board keeps reporting the gym, and every home
// session lands on that gym's leaderboard row.
let lastRegisteredGym: ActiveGym | null | undefined;

function warnOnFailure(error: unknown): void {
  if (__DEV__) console.warn('[analytics] failed to register the active gym', error);
}

// The SDK's register/unregister are declared async but can also throw
// synchronously, so both shapes are swallowed the same way.
function settle(result: unknown): void {
  void Promise.resolve(result).catch(warnOnFailure);
}

function apply(gym: ActiveGym | null, client?: GymRegisterClient | null): void {
  const target = client ?? getPostHogClient();
  if (!target) return;
  try {
    if (gym) {
      settle(target.register({ [GYM_UUID_SUPER_PROPERTY]: gym.uuid, [GYM_NAME_SUPER_PROPERTY]: gym.name }));
      return;
    }
    settle(target.unregister(GYM_UUID_SUPER_PROPERTY));
    settle(target.unregister(GYM_NAME_SUPER_PROPERTY));
  } catch (error) {
    warnOnFailure(error);
  }
}

/**
 * Registers the active board's gym now and remembers it for the rest of the
 * launch. Best effort like `registerConnectivitySuperProperty`: a failure must
 * never break the caller, and it is a silent no-op when analytics is disabled
 * (dev / no key). The value is remembered even then, so a client that appears
 * later still gets it on the next re-registration.
 *
 * Pass `null` for a board with no gym — that clears the property.
 */
export function registerActiveGym(gym: ActiveGym | null): void {
  lastRegisteredGym = gym;
  apply(gym);
}

/**
 * Puts the remembered gym back after `analytics.reset()` wiped it. No-op before
 * the root effect has published anything — there is nothing to restore, and the
 * effect's own registration is still coming.
 */
export function reregisterActiveGym(client?: GymRegisterClient | null): void {
  if (lastRegisteredGym === undefined) return;
  apply(lastRegisteredGym, client);
}

export function __resetActiveGymForTests(): void {
  lastRegisteredGym = undefined;
}
