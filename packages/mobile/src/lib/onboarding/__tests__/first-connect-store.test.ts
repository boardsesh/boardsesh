import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failReads: false,
  failWrites: false,
}));
const rememberedCtrl = vi.hoisted(() => ({ board: null as { configKey: string; serial?: string } | null }));
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => {
    if (storage.failReads) throw new Error('read failed');
    return storage.values.has(key) ? structuredClone(storage.values.get(key)) : null;
  },
  setPreference: async (key: string, value: unknown) => {
    if (storage.failWrites) throw new Error('write failed');
    storage.values.set(key, structuredClone(value));
  },
}));
vi.mock('../../ble/last-connected-board-store', () => ({
  getStoredLastConnectedBoard: async () => rememberedCtrl.board,
}));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));

import {
  bindFirstConnectAccount,
  dismissFirstConnectCardForLaunch,
  dropConnectStepEnrolment,
  getFirstConnectSnapshot,
  loadFirstConnectDevice,
  markFirstConnectConfirmationShown,
  markFirstConnectNoLights,
  markFirstConnectPhoneConnected,
  readConnectStepEnrolment,
  recordFirstConnectCardLaunch,
  recordFirstConnectPillDay,
  resetFirstConnectDeviceForQa,
  resetFirstConnectStoreForTests,
  writeConnectStepEnrolment,
} from '../first-connect-store';
import type { ConnectStepEnrolment } from '../first-connect-decision';

const DEVICE_KEY = 'firstConnectDevice';
const ENROLMENTS_KEY = 'firstConnectEnrolments';

function enrolment(overrides: Partial<ConnectStepEnrolment> = {}): ConnectStepEnrolment {
  return { userId: 'user-1', arm: 'treatment', forced: false, exposedAt: 1_000, ...overrides };
}

describe('first-connect store', () => {
  beforeEach(() => {
    storage.values.clear();
    storage.failReads = false;
    storage.failWrites = false;
    rememberedCtrl.board = null;
    reportErrorMock.mockClear();
    resetFirstConnectStoreForTests();
  });

  describe("this phone's state", () => {
    it('starts a phone with no remembered board as never connected, and stores that', async () => {
      const device = await loadFirstConnectDevice();

      expect(device.connectedAt).toBeNull();
      expect(getFirstConnectSnapshot().device).toEqual(device);
      await vi.waitFor(() => expect(storage.values.get(DEVICE_KEY)).toEqual(device));
    });

    it('seeds a phone that remembers a board as a returning one', async () => {
      rememberedCtrl.board = { configKey: 'kilter:1:10', serial: '1234' };

      const device = await loadFirstConnectDevice();

      expect(device.connectedAt).toBe(0);
    });

    it('never re-seeds a phone that already has its own state', async () => {
      storage.values.set(DEVICE_KEY, {
        connectedAt: null,
        noLightsAt: null,
        confirmationShownAt: null,
        cardLaunchIds: ['a'],
        pillDays: [],
      });
      rememberedCtrl.board = { configKey: 'kilter:1:10', serial: '1234' };

      const device = await loadFirstConnectDevice();

      expect(device.connectedAt).toBeNull();
      expect(device.cardLaunchIds).toEqual(['a']);
    });

    it('does not cache a failed read, so the next caller retries', async () => {
      storage.failReads = true;
      await expect(loadFirstConnectDevice()).rejects.toThrow('read failed');

      storage.failReads = false;
      await expect(loadFirstConnectDevice()).resolves.toMatchObject({ connectedAt: null });
    });

    it('records the first connect once and hands back the state from before it', async () => {
      const before = await markFirstConnectPhoneConnected(5_000);
      const second = await markFirstConnectPhoneConnected(9_000);

      expect(before?.connectedAt).toBeNull();
      expect(second?.connectedAt).toBe(5_000);
      expect(getFirstConnectSnapshot().device?.connectedAt).toBe(5_000);
      expect(storage.values.get(DEVICE_KEY)).toMatchObject({ connectedAt: 5_000 });
    });

    it('keeps "no lights" and the confirmation to their first time', async () => {
      await markFirstConnectNoLights(10);
      await markFirstConnectNoLights(20);
      await markFirstConnectConfirmationShown(30);
      await markFirstConnectConfirmationShown(40);

      expect(getFirstConnectSnapshot().device).toMatchObject({ noLightsAt: 10, confirmationShownAt: 30 });
    });

    it('counts each launch and each day once', async () => {
      await recordFirstConnectCardLaunch('launch-1');
      await recordFirstConnectCardLaunch('launch-1');
      await recordFirstConnectCardLaunch('launch-2');
      await recordFirstConnectPillDay('2026-09-21');
      await recordFirstConnectPillDay('2026-09-21');

      expect(getFirstConnectSnapshot().device).toMatchObject({
        cardLaunchIds: ['launch-1', 'launch-2'],
        pillDays: ['2026-09-21'],
      });
    });

    it('does not lose a change when two land at once', async () => {
      await Promise.all([recordFirstConnectCardLaunch('launch-1'), recordFirstConnectPillDay('2026-09-21')]);

      expect(storage.values.get(DEVICE_KEY)).toMatchObject({
        cardLaunchIds: ['launch-1'],
        pillDays: ['2026-09-21'],
      });
    });

    it('keeps the change in memory and reports it when the write fails', async () => {
      await loadFirstConnectDevice();
      storage.failWrites = true;

      await markFirstConnectNoLights(10);

      expect(getFirstConnectSnapshot().device?.noLightsAt).toBe(10);
      expect(reportErrorMock).toHaveBeenCalled();
    });

    it('wipes the phone for a forced QA arm, without seeding it again', async () => {
      rememberedCtrl.board = { configKey: 'kilter:1:10', serial: '1234' };
      await loadFirstConnectDevice();
      await recordFirstConnectCardLaunch('launch-1');
      dismissFirstConnectCardForLaunch();

      await resetFirstConnectDeviceForQa();

      expect(getFirstConnectSnapshot()).toMatchObject({
        device: { connectedAt: null, cardLaunchIds: [], pillDays: [] },
        cardDismissedThisLaunch: false,
      });
    });
  });

  describe('enrolments', () => {
    it('stores one per account and reads it back', async () => {
      await writeConnectStepEnrolment(enrolment());
      await writeConnectStepEnrolment(enrolment({ userId: 'user-2', arm: 'control' }));

      expect(await readConnectStepEnrolment('user-1')).toEqual(enrolment());
      expect(await readConnectStepEnrolment('user-2')).toMatchObject({ arm: 'control' });
      expect(await readConnectStepEnrolment('user-3')).toBeNull();
    });

    it('ignores a malformed entry rather than trusting it', async () => {
      storage.values.set(ENROLMENTS_KEY, { 'user-1': { arm: 'both', forced: false, exposedAt: 1 } });

      expect(await readConnectStepEnrolment('user-1')).toBeNull();
    });

    it('keeps the blob bounded, dropping the oldest exposures first', async () => {
      for (let index = 0; index < 12; index += 1) {
        await writeConnectStepEnrolment(enrolment({ userId: `user-${index}`, exposedAt: index }));
      }

      const stored = storage.values.get(ENROLMENTS_KEY) as Record<string, unknown>;
      expect(Object.keys(stored)).toHaveLength(10);
      expect(stored['user-0']).toBeUndefined();
      expect(stored['user-11']).toBeDefined();
    });

    it('publishes the signed-in account and nobody else', async () => {
      await bindFirstConnectAccount('user-1');

      await writeConnectStepEnrolment(enrolment({ userId: 'user-2' }));
      expect(getFirstConnectSnapshot().enrolment).toBeNull();

      await writeConnectStepEnrolment(enrolment());
      expect(getFirstConnectSnapshot().enrolment).toEqual(enrolment());
    });

    it('loads the enrolment of whoever signs in, and clears it on sign-out', async () => {
      await writeConnectStepEnrolment(enrolment());

      await expect(bindFirstConnectAccount('user-1')).resolves.toEqual(enrolment());
      expect(getFirstConnectSnapshot()).toMatchObject({ userId: 'user-1', enrolment: enrolment() });

      await expect(bindFirstConnectAccount(null)).resolves.toBeNull();
      expect(getFirstConnectSnapshot()).toMatchObject({ userId: null, enrolment: null });
    });

    it('drops an enrolment', async () => {
      await bindFirstConnectAccount('user-1');
      await writeConnectStepEnrolment(enrolment());

      await dropConnectStepEnrolment('user-1');

      expect(await readConnectStepEnrolment('user-1')).toBeNull();
      expect(getFirstConnectSnapshot().enrolment).toBeNull();
    });
  });
});
