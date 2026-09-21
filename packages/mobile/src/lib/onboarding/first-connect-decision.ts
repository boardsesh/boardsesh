// The connect-step test (#5654, PR 7) as pure functions: who is enrolled, and
// when each of the three surfaces shows. Kept free of React and storage so the
// whole matrix is testable without a renderer.
//
// The surfaces:
// - treatment only: a card at the top of the Climbs list ("Light climbs on
//   {{board}}") and a labelled "Light it on the board" pill in place of the
//   play view's bare bulb;
// - both arms: a one-time "Connected to {{board}}" confirmation after this
//   phone's first successful connect.

import { isNewAccount } from './first-board-picker-decision';
import { assignConnectStepArm, type ConnectStepArm } from './connect-step-arm';

/** How many app launches the Climbs card may appear on. */
export const FIRST_CONNECT_CARD_MAX_LAUNCHES = 2;

/** How many calendar days (the phone's own) the play-view pill may appear on. */
export const FIRST_CONNECT_PILL_MAX_DAYS = 3;

/** One account's place in the test, written once, at exposure. */
export type ConnectStepEnrolment = {
  userId: string;
  arm: ConnectStepArm;
  /** Set by the QA override in More → Feature Flags, not by the hash. */
  forced: boolean;
  /** When `First Run Exposed` fired, in ms. */
  exposedAt: number;
};

/**
 * What this phone has done with a board, kept on the phone and across sign-outs
 * (it is about the phone and the wall, not the account).
 */
export type FirstConnectDeviceState = {
  /**
   * The first successful connect this phone made, in ms. `0` means "before this
   * was tracked": a board was already remembered for a one-tap reconnect when
   * the state was first created, so this phone is a returning one.
   */
  connectedAt: number | null;
  /** "This wall has no lights" was tapped, or chosen in the device picker. Permanent. */
  noLightsAt: number | null;
  /** The first-connect confirmation was shown. */
  confirmationShownAt: number | null;
  /** The launches the Climbs card appeared on (one id per JS process). */
  cardLaunchIds: string[];
  /** The local calendar days (`YYYY-MM-DD`) the play-view pill appeared on. */
  pillDays: string[];
};

export const EMPTY_FIRST_CONNECT_DEVICE_STATE: FirstConnectDeviceState = {
  connectedAt: null,
  noLightsAt: null,
  confirmationShownAt: null,
  cardLaunchIds: [],
  pillDays: [],
};

/** Why an account was not enrolled, or `enrolled`/`already_enrolled`. */
export type ConnectStepEnrolmentVerdict =
  | 'enrolled'
  | 'already_enrolled'
  /** No profile id or creation time: signed out, or the profile read failed. */
  | 'profile_unavailable'
  /** Older than seven days (the same line as the first-board picker). */
  | 'not_new_account'
  /** `first-connect-cta-kill` is on. */
  | 'kill_switch'
  /**
   * This phone has connected to a board before (or remembers one), so neither
   * arm has anything to teach. Settled before assignment, so it removes the
   * same climbers from both arms.
   */
  | 'connected_before'
  /** The enrolment could not be read or written. */
  | 'storage_error'
  /**
   * The Expo browser build. The test is about the store app, whose first
   * launch is where newcomers stall; a browser exposure would only add noise.
   */
  | 'unsupported_platform';

export type ConnectStepEnrolmentInput = {
  userId: string | undefined;
  accountCreatedAt: string | null | undefined;
  nowMs: number;
  /** False when `first-connect-cta-kill` is on. */
  enabled: boolean;
  /** `connectedAt` on this phone's state is set. */
  phoneHasConnected: boolean;
  /** The QA override's arm, or null when none is set. */
  forcedArm: ConnectStepArm | null;
  /** What this phone already holds for the account, if anything. */
  existing: ConnectStepEnrolment | null;
};

export type ConnectStepEnrolmentDecision =
  | {
      verdict: 'enrolled';
      enrolment: ConnectStepEnrolment;
      /** An earlier enrolment of this account is being replaced (the QA override moved). */
      replacesExisting: boolean;
    }
  | { verdict: 'already_enrolled'; enrolment: ConnectStepEnrolment }
  | {
      verdict: Exclude<ConnectStepEnrolmentVerdict, 'enrolled' | 'already_enrolled'>;
      /** A forced enrolment the override no longer asks for, to be dropped. */
      dropForced: boolean;
    };

/**
 * Whether the account joins the test now.
 *
 * Eligibility is the first-board picker's new-account line (signed in, at most
 * 7 days old; `isNewAccount`), plus the kill switch and a phone that has never
 * connected. The arm is only dealt after all of that, so neither arm can lose
 * climbers the other keeps.
 *
 * An account is enrolled once. The QA override is the one thing that can change
 * an enrolment: forcing an arm re-enrols the account as `forced`, and clearing
 * the override drops the forced enrolment so the account is judged afresh.
 * Forcing skips the age and never-connected checks (a tester's phone has
 * usually connected before), but not the kill switch.
 */
export function decideConnectStepEnrolment(input: ConnectStepEnrolmentInput): ConnectStepEnrolmentDecision {
  const { existing, forcedArm } = input;
  if (!input.userId) return { verdict: 'profile_unavailable', dropForced: false };

  const staleForced = existing !== null && existing.forced && forcedArm === null;
  const overrideMatches = existing !== null && existing.forced && existing.arm === forcedArm;
  if (existing !== null && !staleForced && (forcedArm === null || overrideMatches)) {
    return { verdict: 'already_enrolled', enrolment: existing };
  }

  if (!input.enabled) return { verdict: 'kill_switch', dropForced: staleForced };

  if (forcedArm !== null) {
    return {
      verdict: 'enrolled',
      enrolment: { userId: input.userId, arm: forcedArm, forced: true, exposedAt: input.nowMs },
      replacesExisting: existing !== null,
    };
  }

  if (!input.accountCreatedAt || Number.isNaN(Date.parse(input.accountCreatedAt))) {
    return { verdict: 'profile_unavailable', dropForced: staleForced };
  }
  if (!isNewAccount(input.accountCreatedAt, input.nowMs)) {
    return { verdict: 'not_new_account', dropForced: staleForced };
  }
  if (input.phoneHasConnected) return { verdict: 'connected_before', dropForced: staleForced };

  return {
    verdict: 'enrolled',
    enrolment: {
      userId: input.userId,
      arm: assignConnectStepArm(input.userId),
      forced: false,
      exposedAt: input.nowMs,
    },
    replacesExisting: staleForced,
  };
}

/**
 * The treatment is live for this account on this phone: enrolled in treatment,
 * not killed, the phone has never connected, and nobody said the wall has no
 * lights. Every treatment surface starts from this.
 */
export function isConnectStepTreatmentLive(input: {
  enrolment: ConnectStepEnrolment | null;
  enabled: boolean;
  device: FirstConnectDeviceState | null;
}): boolean {
  const { enrolment, device } = input;
  if (!input.enabled || enrolment === null || enrolment.arm !== 'treatment' || device === null) return false;
  return device.connectedAt === null && device.noLightsAt === null;
}

export type FirstConnectCardInput = {
  treatmentLive: boolean;
  /** A board is bound and it has not been flagged as having no lights. */
  boardHasLights: boolean;
  /** The climber closed the card ("Not now") during this launch. */
  dismissedThisLaunch: boolean;
  launchId: string;
  cardLaunchIds: readonly string[];
  /**
   * Nobody else is driving the wall: no session peer holds it and it is not held
   * by another account. A connect from here could only fail then.
   */
  wallFree: boolean;
};

/**
 * The Climbs card: on at most two launches, and a launch it already appeared on
 * keeps it (so recording the launch never hides the card it was recorded for).
 */
export function shouldShowFirstConnectCard(input: FirstConnectCardInput): boolean {
  if (!input.treatmentLive || !input.boardHasLights || input.dismissedThisLaunch || !input.wallFree) return false;
  if (input.cardLaunchIds.includes(input.launchId)) return true;
  return input.cardLaunchIds.length < FIRST_CONNECT_CARD_MAX_LAUNCHES;
}

export type FirstConnectPillInput = {
  treatmentLive: boolean;
  /** Today on the phone's own calendar, `YYYY-MM-DD`. */
  today: string;
  pillDays: readonly string[];
  /**
   * The bulb's tap would connect this phone: a Bluetooth provider exists, the
   * viewer is signed in, the row is not in commit mode, there is no party
   * session, and nobody else holds the wall. A connect already in flight keeps
   * the pill, so it does not jump back to a bulb mid-connect.
   */
  wouldConnect: boolean;
};

/** The play-view pill: on at most three calendar days, same rule as the card. */
export function shouldShowFirstConnectPill(input: FirstConnectPillInput): boolean {
  if (!input.treatmentLive || !input.wouldConnect) return false;
  if (input.pillDays.includes(input.today)) return true;
  return input.pillDays.length < FIRST_CONNECT_PILL_MAX_DAYS;
}

/**
 * The confirmation after the first successful connect, in both arms. Only for
 * an enrolled account, never with the kill switch on, only once per phone, and
 * only while tapping a climb really does light it (`lightOnClimbTap`), since
 * that is what it says.
 */
export function shouldConfirmFirstConnect(input: {
  enrolment: ConnectStepEnrolment | null;
  enabled: boolean;
  /** The phone's state BEFORE this connect was recorded. */
  device: FirstConnectDeviceState;
  lightOnClimbTap: boolean;
}): boolean {
  if (!input.enabled || input.enrolment === null || !input.lightOnClimbTap) return false;
  return input.device.connectedAt === null && input.device.confirmationShownAt === null;
}

/** The phone's local calendar day, `YYYY-MM-DD`. */
export function localDayKey(atMs: number): string {
  const date = new Date(atMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
