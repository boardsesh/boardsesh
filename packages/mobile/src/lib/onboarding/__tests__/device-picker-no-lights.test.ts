import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeCtrl = vi.hoisted(() => ({
  recorded: true,
  enrolment: null as { arm: string } | null,
}));
const markMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../first-connect-store', () => ({
  markFirstConnectNoLightsBeforeFirstConnect: markMock,
  getFirstConnectSnapshot: () => ({ enrolment: storeCtrl.enrolment }),
}));
vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('../../clock', () => ({ nowMs: () => 42 }));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));

const { recordDevicePickerNoLights } = await import('../device-picker-no-lights');

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('recordDevicePickerNoLights', () => {
  beforeEach(() => {
    storeCtrl.recorded = true;
    storeCtrl.enrolment = { arm: 'control' };
    markMock.mockReset();
    markMock.mockImplementation(async () => storeCtrl.recorded);
    trackMock.mockClear();
    reportErrorMock.mockClear();
  });

  it('keeps it on the phone and tells the test, in either arm', async () => {
    recordDevicePickerNoLights();
    await settle();

    expect(markMock).toHaveBeenCalledWith(42);
    expect(trackMock).toHaveBeenCalledWith('Board Lights Declined', { surface: 'device_picker' });
  });

  it('keeps it on the phone but sends nothing for an account outside the test', async () => {
    storeCtrl.enrolment = null;
    recordDevicePickerNoLights();
    await settle();

    expect(markMock).toHaveBeenCalledTimes(1);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('sends nothing when this tap recorded nothing (said before, or the phone has connected)', async () => {
    storeCtrl.recorded = false;
    recordDevicePickerNoLights();
    await settle();

    expect(trackMock).not.toHaveBeenCalled();
  });

  it('never throws at the picker', async () => {
    markMock.mockRejectedValue(new Error('storage gone'));
    expect(() => recordDevicePickerNoLights()).not.toThrow();
    await settle();

    expect(reportErrorMock).toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });
});
