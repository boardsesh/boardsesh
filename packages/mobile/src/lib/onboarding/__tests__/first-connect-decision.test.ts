import { describe, expect, it } from 'vitest';
import { assignConnectStepArm } from '../connect-step-arm';
import {
  CONNECT_STEP_MIN_NATIVE_VERSION,
  EMPTY_FIRST_CONNECT_DEVICE_STATE,
  FIRST_CONNECT_CARD_MAX_LAUNCHES,
  FIRST_CONNECT_PILL_MAX_DAYS,
  decideConnectStepEnrolment,
  deriveFirstConnectPillWouldConnect,
  isConnectStepTreatmentLive,
  localDayKey,
  shouldConfirmFirstConnect,
  shouldShowFirstConnectCard,
  shouldShowFirstConnectPill,
  type ConnectStepEnrolment,
  type ConnectStepEnrolmentInput,
  type FirstConnectDeviceState,
  type FirstConnectPillWouldConnectInput,
} from '../first-connect-decision';

const NOW_MS = Date.parse('2026-09-21T12:00:00.000Z');
const NEW_ACCOUNT_CREATED_AT = '2026-09-20T12:00:00.000Z';
const OLD_ACCOUNT_CREATED_AT = '2026-09-10T12:00:00.000Z';
const TREATMENT_USER = '00000000-0000-4000-8000-000000000001';

function enrolmentInput(overrides: Partial<ConnectStepEnrolmentInput> = {}): ConnectStepEnrolmentInput {
  return {
    userId: TREATMENT_USER,
    accountCreatedAt: NEW_ACCOUNT_CREATED_AT,
    nowMs: NOW_MS,
    enabled: true,
    nativeVersion: CONNECT_STEP_MIN_NATIVE_VERSION,
    productionBuild: true,
    phoneHasConnected: false,
    forcedArm: null,
    existing: null,
    ...overrides,
  };
}

function enrolment(overrides: Partial<ConnectStepEnrolment> = {}): ConnectStepEnrolment {
  return { userId: TREATMENT_USER, arm: 'treatment', forced: false, exposedAt: NOW_MS - 1000, ...overrides };
}

function device(overrides: Partial<FirstConnectDeviceState> = {}): FirstConnectDeviceState {
  return { ...EMPTY_FIRST_CONNECT_DEVICE_STATE, ...overrides };
}

describe('decideConnectStepEnrolment', () => {
  it('enrols a new account on a phone that has never connected, in its hashed arm', () => {
    const decision = decideConnectStepEnrolment(enrolmentInput());

    expect(decision).toEqual({
      verdict: 'enrolled',
      enrolment: {
        userId: TREATMENT_USER,
        arm: assignConnectStepArm(TREATMENT_USER),
        forced: false,
        exposedAt: NOW_MS,
      },
      replacesExisting: false,
    });
  });

  it('enrols control accounts too: exposure fires in both arms', () => {
    const controlUser = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const decision = decideConnectStepEnrolment(enrolmentInput({ userId: controlUser }));

    expect(decision).toMatchObject({ verdict: 'enrolled', enrolment: { arm: 'control', forced: false } });
  });

  it('never enrols the same account twice', () => {
    const existing = enrolment();
    expect(decideConnectStepEnrolment(enrolmentInput({ existing }))).toEqual({
      verdict: 'already_enrolled',
      enrolment: existing,
    });
  });

  it('keeps an enrolment even after the account ages out or the phone connects', () => {
    const existing = enrolment();
    const decision = decideConnectStepEnrolment(
      enrolmentInput({ existing, accountCreatedAt: OLD_ACCOUNT_CREATED_AT, phoneHasConnected: true }),
    );
    expect(decision.verdict).toBe('already_enrolled');
  });

  it.each([
    ['no account', { userId: undefined }, 'profile_unavailable'],
    ['no creation time', { accountCreatedAt: null }, 'profile_unavailable'],
    ['an unreadable creation time', { accountCreatedAt: 'yesterday' }, 'profile_unavailable'],
    ['an account older than seven days', { accountCreatedAt: OLD_ACCOUNT_CREATED_AT }, 'not_new_account'],
    ['the kill switch on', { enabled: false }, 'kill_switch'],
    ['a phone that has connected before', { phoneHasConnected: true }, 'connected_before'],
    ['a dev, EAS preview or pr-* preview build', { productionBuild: false }, 'not_production_build'],
    ['the 2.6 binary', { nativeVersion: '2.6.9' }, 'below_native_floor'],
    ['the 2.5 binary', { nativeVersion: '2.5.0' }, 'below_native_floor'],
    ['an unreadable binary version', { nativeVersion: null }, 'below_native_floor'],
    ['a pre-release binary version', { nativeVersion: '2.7.0-beta.1' }, 'below_native_floor'],
  ] as const)('does not enrol with %s', (_label, overrides, verdict) => {
    expect(decideConnectStepEnrolment(enrolmentInput(overrides))).toEqual({ verdict, dropForced: false });
  });

  it.each(['2.7.0', '2.7.1', '2.8.0', '3.0.0'])('enrols on the %s binary', (nativeVersion) => {
    expect(decideConnectStepEnrolment(enrolmentInput({ nativeVersion })).verdict).toBe('enrolled');
  });

  it('settles the binary before the account, so an older binary never deals an arm', () => {
    // Every other check would pass: only the floor keeps this account out.
    expect(decideConnectStepEnrolment(enrolmentInput({ nativeVersion: '2.6.0' })).verdict).toBe('below_native_floor');
  });

  describe('the QA override', () => {
    it('forces an arm whatever the account age and phone history', () => {
      const decision = decideConnectStepEnrolment(
        enrolmentInput({ forcedArm: 'control', accountCreatedAt: OLD_ACCOUNT_CREATED_AT, phoneHasConnected: true }),
      );

      expect(decision).toEqual({
        verdict: 'enrolled',
        enrolment: { userId: TREATMENT_USER, arm: 'control', forced: true, exposedAt: NOW_MS },
        replacesExisting: false,
      });
    });

    it("reaches testers on preview builds and today's binaries", () => {
      expect(
        decideConnectStepEnrolment(
          enrolmentInput({ forcedArm: 'treatment', productionBuild: false, nativeVersion: '2.5.0' }),
        ),
      ).toMatchObject({ verdict: 'enrolled', enrolment: { arm: 'treatment', forced: true } });
    });

    it('drops a forced enrolment on a preview build once the override is cleared', () => {
      const existing = enrolment({ forced: true, arm: 'treatment' });
      expect(decideConnectStepEnrolment(enrolmentInput({ existing, productionBuild: false }))).toEqual({
        verdict: 'not_production_build',
        dropForced: true,
      });
    });

    it('does not beat the kill switch', () => {
      expect(decideConnectStepEnrolment(enrolmentInput({ forcedArm: 'treatment', enabled: false })).verdict).toBe(
        'kill_switch',
      );
    });

    it('replaces a natural enrolment when a tester forces an arm', () => {
      const decision = decideConnectStepEnrolment(enrolmentInput({ forcedArm: 'control', existing: enrolment() }));
      expect(decision).toMatchObject({
        verdict: 'enrolled',
        enrolment: { arm: 'control', forced: true },
        replacesExisting: true,
      });
    });

    it('leaves a forced enrolment alone while the override still asks for it', () => {
      const existing = enrolment({ forced: true, arm: 'treatment' });
      expect(decideConnectStepEnrolment(enrolmentInput({ forcedArm: 'treatment', existing })).verdict).toBe(
        'already_enrolled',
      );
    });

    it('re-enrols when the override moves to the other arm', () => {
      const existing = enrolment({ forced: true, arm: 'treatment' });
      expect(decideConnectStepEnrolment(enrolmentInput({ forcedArm: 'control', existing }))).toMatchObject({
        verdict: 'enrolled',
        enrolment: { arm: 'control', forced: true },
        replacesExisting: true,
      });
    });

    it('drops a forced enrolment once the override is cleared, and judges the account afresh', () => {
      const existing = enrolment({ forced: true, arm: 'treatment' });

      expect(
        decideConnectStepEnrolment(enrolmentInput({ existing, accountCreatedAt: OLD_ACCOUNT_CREATED_AT })),
      ).toEqual({ verdict: 'not_new_account', dropForced: true });
      expect(decideConnectStepEnrolment(enrolmentInput({ existing }))).toMatchObject({
        verdict: 'enrolled',
        enrolment: { forced: false },
        replacesExisting: true,
      });
    });
  });
});

describe('isConnectStepTreatmentLive', () => {
  it('is live for an enrolled treatment account on a phone that never connected', () => {
    expect(isConnectStepTreatmentLive({ enrolment: enrolment(), enabled: true, device: device() })).toBe(true);
  });

  it.each([
    ['control', { enrolment: enrolment({ arm: 'control' }), enabled: true, device: device() }],
    ['no enrolment', { enrolment: null, enabled: true, device: device() }],
    ['the kill switch on', { enrolment: enrolment(), enabled: false, device: device() }],
    ['the phone state still loading', { enrolment: enrolment(), enabled: true, device: null }],
    ['a first connect', { enrolment: enrolment(), enabled: true, device: device({ connectedAt: NOW_MS }) }],
    ['a seeded returning phone', { enrolment: enrolment(), enabled: true, device: device({ connectedAt: 0 }) }],
    ['"no lights"', { enrolment: enrolment(), enabled: true, device: device({ noLightsAt: NOW_MS }) }],
  ] as const)('is off with %s', (_label, input) => {
    expect(isConnectStepTreatmentLive(input)).toBe(false);
  });
});

describe('shouldShowFirstConnectCard', () => {
  const base = {
    treatmentLive: true,
    boardHasLights: true,
    dismissedThisLaunch: false,
    launchId: 'launch-3',
    cardLaunchIds: [] as string[],
    wallFree: true,
  };

  it('shows on a first launch', () => {
    expect(shouldShowFirstConnectCard(base)).toBe(true);
  });

  it(`shows on at most ${FIRST_CONNECT_CARD_MAX_LAUNCHES} launches`, () => {
    expect(shouldShowFirstConnectCard({ ...base, cardLaunchIds: ['launch-1'] })).toBe(true);
    expect(shouldShowFirstConnectCard({ ...base, cardLaunchIds: ['launch-1', 'launch-2'] })).toBe(false);
  });

  it('keeps showing on a launch it was already counted for', () => {
    expect(shouldShowFirstConnectCard({ ...base, launchId: 'launch-2', cardLaunchIds: ['launch-1', 'launch-2'] })).toBe(
      true,
    );
  });

  it.each([
    ['outside the treatment', { treatmentLive: false }],
    ['on a board without lights', { boardHasLights: false }],
    ['after "Not now" this launch', { dismissedThisLaunch: true }],
    ['while someone else drives the wall', { wallFree: false }],
  ] as const)('hides %s', (_label, overrides) => {
    expect(shouldShowFirstConnectCard({ ...base, ...overrides })).toBe(false);
  });
});

describe('deriveFirstConnectPillWouldConnect', () => {
  // A signed-in climber alone with the wall, whose bulb tap would connect.
  function wouldConnectInput(
    overrides: Partial<FirstConnectPillWouldConnectInput> = {},
  ): FirstConnectPillWouldConnectInput {
    return {
      isAnonymous: false,
      hasBluetooth: true,
      boardMismatch: false,
      commitMode: false,
      sharedSession: false,
      wallHeldByOtherUser: false,
      tapConnects: true,
      pending: false,
      localConnected: false,
      wallHeldLocally: false,
      ...overrides,
    };
  }

  it('offers the pill where a bulb tap would connect this phone', () => {
    expect(deriveFirstConnectPillWouldConnect(wouldConnectInput())).toBe(true);
  });

  it.each([
    ['a signed-out reader', { isAnonymous: true }],
    ['no board selected', { hasBluetooth: false }],
    ['the switch-board scrim up', { boardMismatch: true }],
    ['commit mode', { commitMode: true }],
    ['a party session with a crew', { sharedSession: true }],
    ['another account holding the wall', { wallHeldByOtherUser: true }],
    ['a bulb tap that would not connect', { tapConnects: false }],
    ['a disconnect in flight', { tapConnects: false, pending: true, localConnected: true }],
    ['a virtual hold being released', { tapConnects: false, pending: true, wallHeldLocally: true }],
    ['a party session, even mid-connect', { tapConnects: false, pending: true, sharedSession: true }],
  ] as const)('hides it for %s', (_label, overrides) => {
    expect(deriveFirstConnectPillWouldConnect(wouldConnectInput(overrides))).toBe(false);
  });

  it('keeps it while a connect is in flight, so it does not turn back into a bulb', () => {
    expect(deriveFirstConnectPillWouldConnect(wouldConnectInput({ tapConnects: false, pending: true }))).toBe(true);
  });
});

describe('shouldShowFirstConnectPill', () => {
  const base = { treatmentLive: true, today: '2026-09-21', pillDays: [] as string[], wouldConnect: true };

  it(`shows on at most ${FIRST_CONNECT_PILL_MAX_DAYS} calendar days`, () => {
    expect(shouldShowFirstConnectPill(base)).toBe(true);
    expect(shouldShowFirstConnectPill({ ...base, pillDays: ['2026-09-18', '2026-09-19'] })).toBe(true);
    expect(shouldShowFirstConnectPill({ ...base, pillDays: ['2026-09-17', '2026-09-18', '2026-09-19'] })).toBe(false);
  });

  it('keeps showing all day on a day already counted', () => {
    expect(shouldShowFirstConnectPill({ ...base, pillDays: ['2026-09-19', '2026-09-20', '2026-09-21'] })).toBe(true);
  });

  it('hides outside the treatment, and wherever a tap would not connect', () => {
    expect(shouldShowFirstConnectPill({ ...base, treatmentLive: false })).toBe(false);
    expect(shouldShowFirstConnectPill({ ...base, wouldConnect: false })).toBe(false);
  });
});

describe('shouldConfirmFirstConnect', () => {
  const base = { enrolment: enrolment(), enabled: true, device: device(), lightOnClimbTap: true };

  it('confirms the first connect of an enrolled account, in either arm', () => {
    expect(shouldConfirmFirstConnect(base)).toBe(true);
    expect(shouldConfirmFirstConnect({ ...base, enrolment: enrolment({ arm: 'control' }) })).toBe(true);
  });

  it.each([
    ['no enrolment', { enrolment: null }],
    ['the kill switch on', { enabled: false }],
    ['a phone that connected before', { device: device({ connectedAt: 1 }) }],
    ['a confirmation already shown', { device: device({ confirmationShownAt: 1 }) }],
    ['lightOnClimbTap off, since the copy would be wrong', { lightOnClimbTap: false }],
  ] as const)('stays quiet with %s', (_label, overrides) => {
    expect(shouldConfirmFirstConnect({ ...base, ...overrides })).toBe(false);
  });
});

describe('localDayKey', () => {
  it('is the phone-local calendar day, zero-padded', () => {
    const localNoon = new Date(2026, 0, 5, 12, 0, 0).getTime();
    expect(localDayKey(localNoon)).toBe('2026-01-05');
  });
});
