import type { PostHog } from 'posthog-react-native';
import { getPostHogClient } from './posthog-client';
import type { ConnectStepArm } from './onboarding/connect-step-arm';

/**
 * The `arm_connect_step` super property: which arm of the connect-step test
 * (#5654, PR 7) the signed-in account is in, stamped onto every event so any
 * funnel splits by arm without a join to `First Run Exposed`.
 *
 * Registered at exposure and again on every launch for an enrolled account
 * (`FirstConnectHost`), and cleared for an account that is not enrolled, so a
 * shared phone never carries one climber's arm onto the next.
 *
 * Own module, same shape as `analytics-gym.ts`, because it has to survive
 * `analytics.reset()`: PostHog's reset clears every registered super property,
 * and nothing re-registers this until the next account's enrolment is read.
 * `reset()` puts the remembered value straight back; the host then replaces it
 * once it knows who signed in.
 */
export const CONNECT_STEP_ARM_SUPER_PROPERTY = 'arm_connect_step';

type ArmRegisterClient = Pick<PostHog, 'register' | 'unregister'>;

// `undefined` = nothing published this launch (leave the client alone).
// `null` = the signed-in account is not enrolled, which must CLEAR the property.
let lastRegisteredArm: ConnectStepArm | null | undefined;

function warnOnFailure(error: unknown): void {
  if (__DEV__) console.warn('[analytics] failed to register the connect-step arm', error);
}

// The SDK's register/unregister are declared async but can also throw
// synchronously, so both shapes are swallowed the same way.
function settle(result: unknown): void {
  void Promise.resolve(result).catch(warnOnFailure);
}

function apply(arm: ConnectStepArm | null, client?: ArmRegisterClient | null): void {
  const target = client ?? getPostHogClient();
  if (!target) return;
  try {
    if (arm) settle(target.register({ [CONNECT_STEP_ARM_SUPER_PROPERTY]: arm }));
    else settle(target.unregister(CONNECT_STEP_ARM_SUPER_PROPERTY));
  } catch (error) {
    warnOnFailure(error);
  }
}

/**
 * Registers the arm now and remembers it for `reset()`. Pass `null` for an
 * account that is not enrolled, which clears the property. Skips the write when
 * nothing changed, since every `register()` is a persisted write.
 */
export function registerConnectStepArm(arm: ConnectStepArm | null): void {
  if (lastRegisteredArm === arm) return;
  lastRegisteredArm = arm;
  apply(arm);
}

/** Puts the remembered arm back after `analytics.reset()` wiped it. */
export function reregisterConnectStepArm(client?: ArmRegisterClient | null): void {
  if (lastRegisteredArm === undefined) return;
  apply(lastRegisteredArm, client);
}

/** Test-only: forget the remembered arm. */
export function __resetConnectStepArmForTests(): void {
  lastRegisteredArm = undefined;
}
