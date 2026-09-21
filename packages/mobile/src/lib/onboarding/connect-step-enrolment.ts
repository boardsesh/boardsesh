// Enrols the signed-in account in the connect-step test (#5654, PR 7) and fires
// `First Run Exposed`. Called by `OnboardingGate` at its post-login decision,
// before any surface can differ between the arms: nothing in the treatment
// shows until the enrolment this writes exists.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import * as Updates from 'expo-updates';
import { track } from '../analytics';
import { registerConnectStepArm } from '../analytics-connect-step-arm';
import { nowMs } from '../clock';
import { reportError } from '../error-reporting';
import { loadFeatureFlagOverrides } from '../feature-flag-overrides';
import type { UiVariant } from '../../theme/resolve-ui-variant';
import { CONNECT_STEP_SALT, isConnectStepArm, type ConnectStepArm } from './connect-step-arm';
import { decideConnectStepEnrolment, type ConnectStepEnrolmentVerdict } from './first-connect-decision';
import {
  dropConnectStepEnrolment,
  loadFirstConnectDevice,
  readConnectStepEnrolment,
  resetFirstConnectDeviceForQa,
  writeConnectStepEnrolment,
} from './first-connect-store';
import { accountAgeHours } from './onboarding-gate-analytics';

/**
 * The QA override: a multivariate row in More → Feature Flags that forces the
 * signed-in account into an arm. Read from the ON-DEVICE override only, never
 * from PostHog, so a flag of the same name created there cannot move real
 * climbers between arms. Forced exposures carry `arm_forced: true`, so the
 * analysis leaves them out.
 */
export const CONNECT_STEP_FORCE_ARM_FLAG = 'first-connect-cta-arm';

export type ConnectStepEnrolmentRequest = {
  userId: string | undefined;
  accountCreatedAt: string | null | undefined;
  /** False when `first-connect-cta-kill` is on. */
  enabled: boolean;
  hadBoard: boolean;
  uiVariant: UiVariant | null;
};

async function readForcedArm(): Promise<ConnectStepArm | null> {
  try {
    const overrides = await loadFeatureFlagOverrides();
    const forced = overrides[CONNECT_STEP_FORCE_ARM_FLAG];
    return isConnectStepArm(forced) ? forced : null;
  } catch {
    return null;
  }
}

async function enrol(request: ConnectStepEnrolmentRequest): Promise<ConnectStepEnrolmentVerdict> {
  const { userId } = request;
  if (!userId) return 'profile_unavailable';

  let phoneHasConnected: boolean;
  let existing: Awaited<ReturnType<typeof readConnectStepEnrolment>>;
  try {
    const [device, stored] = await Promise.all([loadFirstConnectDevice(), readConnectStepEnrolment(userId)]);
    phoneHasConnected = device.connectedAt !== null;
    existing = stored;
  } catch (error: unknown) {
    reportError(error);
    return 'storage_error';
  }
  const forcedArm = await readForcedArm();
  const decidedAtMs = nowMs();
  const decision = decideConnectStepEnrolment({
    userId,
    accountCreatedAt: request.accountCreatedAt,
    nowMs: decidedAtMs,
    enabled: request.enabled,
    phoneHasConnected,
    forcedArm,
    existing,
  });

  if (decision.verdict === 'already_enrolled') {
    registerConnectStepArm(decision.enrolment.arm);
    return 'already_enrolled';
  }
  if (decision.verdict !== 'enrolled') {
    if (decision.dropForced) {
      try {
        await dropConnectStepEnrolment(userId);
        registerConnectStepArm(null);
      } catch (error: unknown) {
        reportError(error);
      }
    }
    return decision.verdict;
  }

  const { enrolment } = decision;
  try {
    // A forced arm starts the phone from a clean slate, so a tester whose phone
    // has connected before still sees the card and the pill.
    if (enrolment.forced) await resetFirstConnectDeviceForQa();
    // Written BEFORE the event: an enrolment that cannot be stored cannot hold
    // an arm either, and a climber who was never enrolled must not be counted.
    await writeConnectStepEnrolment(enrolment);
  } catch (error: unknown) {
    reportError(error);
    return 'storage_error';
  }

  registerConnectStepArm(enrolment.arm);
  track(SHARED_EVENTS.FirstRunExposed, {
    arm_connect_step: enrolment.arm,
    arm_forced: enrolment.forced,
    assignment_salt: CONNECT_STEP_SALT,
    // Analysis is by account: about 8% of newcomers show up split across two
    // PostHog persons, so the id travels on the event itself.
    user_id: userId,
    account_age_hours: accountAgeHours(request.accountCreatedAt, decidedAtMs),
    // First launches run the binary's embedded JS, so this splits the store
    // release that enrols from the OTAs after it.
    ota_is_embedded: Updates.isEmbeddedLaunch,
    ui_variant: request.uiVariant,
    had_board: request.hadBoard,
  });
  return 'enrolled';
}

let enrolmentChain: Promise<unknown> = Promise.resolve();

/**
 * Serialised: a gate run cancelled mid-read and its re-run can both reach here
 * for the same account, and only the first may write the enrolment and fire the
 * event. Never rejects.
 */
export function enrolInConnectStep(request: ConnectStepEnrolmentRequest): Promise<ConnectStepEnrolmentVerdict> {
  const run = enrolmentChain.then(() => enrol(request));
  const settled = run.catch((error: unknown): ConnectStepEnrolmentVerdict => {
    reportError(error);
    return 'storage_error';
  });
  enrolmentChain = settled;
  return settled;
}
