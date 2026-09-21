import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ values: new Map<string, unknown>(), failWrites: false }));
const platformCtrl = vi.hoisted(() => ({ OS: 'ios' as string }));
const rememberedCtrl = vi.hoisted(() => ({ board: null as { configKey: string; serial?: string } | null }));
const overridesCtrl = vi.hoisted(() => ({ overrides: {} as Record<string, boolean | string> }));
const clockCtrl = vi.hoisted(() => ({ nowMs: Date.parse('2026-09-21T12:00:00.000Z') }));
const buildCtrl = vi.hoisted(() => ({ nativeVersion: '2.7.0' as string | null, productionBuild: true }));
const trackMock = vi.hoisted(() => vi.fn());
const registerArmMock = vi.hoisted(() => vi.fn());
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformCtrl.OS;
    },
  },
}));
vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => (storage.values.has(key) ? structuredClone(storage.values.get(key)) : null),
  setPreference: async (key: string, value: unknown) => {
    if (storage.failWrites) throw new Error('write failed');
    storage.values.set(key, structuredClone(value));
  },
}));
vi.mock('../../ble/last-connected-board-store', () => ({
  getStoredLastConnectedBoard: async () => rememberedCtrl.board,
}));
vi.mock('../../feature-flag-overrides', () => ({
  loadFeatureFlagOverrides: async () => overridesCtrl.overrides,
}));
vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('../../analytics-connect-step-arm', () => ({ registerConnectStepArm: registerArmMock }));
vi.mock('../../clock', () => ({ nowMs: () => clockCtrl.nowMs }));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));
vi.mock('expo-updates', () => ({ isEmbeddedLaunch: true }));
vi.mock('../connect-step-build', () => ({
  readConnectStepBuild: () => ({ nativeVersion: buildCtrl.nativeVersion, productionBuild: buildCtrl.productionBuild }),
}));

import {
  CONNECT_STEP_FORCE_ARM_FLAG,
  enrolInConnectStep,
  type ConnectStepEnrolmentRequest,
} from '../connect-step-enrolment';
import {
  bindFirstConnectAccount,
  getFirstConnectSnapshot,
  markFirstConnectPhoneConnected,
  readConnectStepEnrolment,
  recordFirstConnectCardLaunch,
  resetFirstConnectStoreForTests,
} from '../first-connect-store';

// Treatment by the hash (see connect-step-arm.test.ts).
const TREATMENT_USER = '00000000-0000-4000-8000-000000000001';
const CONTROL_USER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const NEW_ACCOUNT_CREATED_AT = '2026-09-20T12:00:00.000Z';
const OLD_ACCOUNT_CREATED_AT = '2026-09-01T12:00:00.000Z';

function request(overrides: Partial<ConnectStepEnrolmentRequest> = {}): ConnectStepEnrolmentRequest {
  return {
    userId: TREATMENT_USER,
    accountCreatedAt: NEW_ACCOUNT_CREATED_AT,
    enabled: true,
    hadBoard: false,
    uiVariant: 'liquidGlass',
    ...overrides,
  };
}

function exposures(): Array<Record<string, unknown>> {
  return trackMock.mock.calls
    .filter(([name]) => name === 'First Run Exposed')
    .map(([, properties]) => properties as Record<string, unknown>);
}

describe('enrolInConnectStep', () => {
  beforeEach(() => {
    storage.values.clear();
    storage.failWrites = false;
    platformCtrl.OS = 'ios';
    rememberedCtrl.board = null;
    overridesCtrl.overrides = {};
    buildCtrl.nativeVersion = '2.7.0';
    buildCtrl.productionBuild = true;
    trackMock.mockClear();
    registerArmMock.mockClear();
    reportErrorMock.mockClear();
    resetFirstConnectStoreForTests();
  });

  it('enrols a new account, stores the arm, registers it and fires the exposure', async () => {
    await expect(enrolInConnectStep(request({ hadBoard: true }))).resolves.toBe('enrolled');

    expect(await readConnectStepEnrolment(TREATMENT_USER)).toMatchObject({ arm: 'treatment', forced: false });
    expect(registerArmMock).toHaveBeenCalledWith('treatment');
    expect(exposures()).toEqual([
      {
        arm_connect_step: 'treatment',
        arm_forced: false,
        assignment_salt: 'first-connect-cta-v1',
        user_id: TREATMENT_USER,
        account_age_hours: 24,
        ota_is_embedded: true,
        native_version: '2.7.0',
        ui_variant: 'liquidGlass',
        had_board: true,
      },
    ]);
    // The super property is on before the event, so the exposure carries it too.
    expect(registerArmMock.mock.invocationCallOrder[0]).toBeLessThan(trackMock.mock.invocationCallOrder[0]);
  });

  it('exposes control accounts the same way', async () => {
    await enrolInConnectStep(request({ userId: CONTROL_USER }));

    expect(exposures()).toEqual([expect.objectContaining({ arm_connect_step: 'control', user_id: CONTROL_USER })]);
  });

  it('fires once per account, however many launches ask', async () => {
    await enrolInConnectStep(request());
    await expect(enrolInConnectStep(request())).resolves.toBe('already_enrolled');

    expect(exposures()).toHaveLength(1);
    // Still re-registered, since a launch starts with no super property set.
    expect(registerArmMock).toHaveBeenLastCalledWith('treatment');
  });

  it('fires once when two gate runs race for the same account', async () => {
    const verdicts = await Promise.all([enrolInConnectStep(request()), enrolInConnectStep(request())]);

    expect(verdicts.sort()).toEqual(['already_enrolled', 'enrolled']);
    expect(exposures()).toHaveLength(1);
  });

  it.each([
    ['an existing account', { accountCreatedAt: OLD_ACCOUNT_CREATED_AT }, 'not_new_account'],
    ['the kill switch on', { enabled: false }, 'kill_switch'],
    ['no profile', { userId: undefined }, 'profile_unavailable'],
  ] as const)('leaves %s out, with no event', async (_label, overrides, verdict) => {
    await expect(enrolInConnectStep(request(overrides))).resolves.toBe(verdict);

    expect(exposures()).toEqual([]);
    expect(registerArmMock).not.toHaveBeenCalled();
  });

  it('stays inert on a binary older than 2.7.0, where a first launch runs older JS', async () => {
    buildCtrl.nativeVersion = '2.6.0';

    await expect(enrolInConnectStep(request())).resolves.toBe('below_native_floor');
    expect(exposures()).toEqual([]);
    expect(await readConnectStepEnrolment(TREATMENT_USER)).toBeNull();
  });

  it('leaves preview builds out: accounts made there are testers', async () => {
    buildCtrl.productionBuild = false;

    await expect(enrolInConnectStep(request())).resolves.toBe('not_production_build');
    expect(exposures()).toEqual([]);
  });

  it('leaves the Expo browser build out: the test is about the store app', async () => {
    platformCtrl.OS = 'web';

    await expect(enrolInConnectStep(request())).resolves.toBe('unsupported_platform');
    expect(exposures()).toEqual([]);
  });

  it('leaves a phone that remembers a board out: a returning climber never sees the treatment', async () => {
    rememberedCtrl.board = { configKey: 'kilter:1:10', serial: '1234' };

    await expect(enrolInConnectStep(request())).resolves.toBe('connected_before');
    expect(exposures()).toEqual([]);
  });

  it('leaves a phone that has connected before out', async () => {
    await markFirstConnectPhoneConnected(1);

    await expect(enrolInConnectStep(request())).resolves.toBe('connected_before');
  });

  it('fires nothing when the enrolment cannot be stored', async () => {
    storage.failWrites = true;

    await expect(enrolInConnectStep(request())).resolves.toBe('storage_error');
    expect(exposures()).toEqual([]);
    expect(reportErrorMock).toHaveBeenCalled();
  });

  describe('the QA override', () => {
    it('forces the arm for any account, tags the exposure, and starts the phone clean', async () => {
      rememberedCtrl.board = { configKey: 'kilter:1:10', serial: '1234' };
      overridesCtrl.overrides = { [CONNECT_STEP_FORCE_ARM_FLAG]: 'treatment' };
      await recordFirstConnectCardLaunch('earlier-launch');

      await expect(
        enrolInConnectStep(request({ userId: CONTROL_USER, accountCreatedAt: OLD_ACCOUNT_CREATED_AT })),
      ).resolves.toBe('enrolled');

      expect(exposures()).toEqual([
        expect.objectContaining({ arm_connect_step: 'treatment', arm_forced: true, user_id: CONTROL_USER }),
      ]);
      expect(getFirstConnectSnapshot().device).toMatchObject({ connectedAt: null, cardLaunchIds: [] });
    });

    it('reaches a tester on a preview of an older binary', async () => {
      buildCtrl.nativeVersion = '2.5.0';
      buildCtrl.productionBuild = false;
      overridesCtrl.overrides = { [CONNECT_STEP_FORCE_ARM_FLAG]: 'control' };

      await expect(enrolInConnectStep(request())).resolves.toBe('enrolled');
      expect(exposures()).toEqual([
        expect.objectContaining({ arm_connect_step: 'control', arm_forced: true, native_version: '2.5.0' }),
      ]);
    });

    it('ignores anything but a declared arm', async () => {
      overridesCtrl.overrides = { [CONNECT_STEP_FORCE_ARM_FLAG]: true };

      await expect(enrolInConnectStep(request({ accountCreatedAt: OLD_ACCOUNT_CREATED_AT }))).resolves.toBe(
        'not_new_account',
      );
    });

    it('drops the forced arm once the override is cleared', async () => {
      await bindFirstConnectAccount(CONTROL_USER);
      overridesCtrl.overrides = { [CONNECT_STEP_FORCE_ARM_FLAG]: 'treatment' };
      await enrolInConnectStep(request({ userId: CONTROL_USER, accountCreatedAt: OLD_ACCOUNT_CREATED_AT }));
      overridesCtrl.overrides = {};

      await expect(
        enrolInConnectStep(request({ userId: CONTROL_USER, accountCreatedAt: OLD_ACCOUNT_CREATED_AT })),
      ).resolves.toBe('not_new_account');

      expect(await readConnectStepEnrolment(CONTROL_USER)).toBeNull();
      expect(getFirstConnectSnapshot().enrolment).toBeNull();
      expect(registerArmMock).toHaveBeenLastCalledWith(null);
    });
  });
});
