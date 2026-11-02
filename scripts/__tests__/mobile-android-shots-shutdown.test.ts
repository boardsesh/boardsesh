import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectDevClientMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/android-dev-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/android-dev-client')>()),
  connectDevClient: connectDevClientMock,
}));

import { METRO_PORT, SCREENSHOT_READY_PORT, parseSsListenerPids } from '../lib/metro-dev-server';
import { ANDROID_SHOTS_SHUTDOWN_PORTS, connectShotsDevClient } from '../mobile-android-shots';
import { androidShotsReversePorts } from '../mobile-screenshots';

beforeEach(() => connectDevClientMock.mockClear());

describe('androidShotsReversePorts', () => {
  it('reverses the local backend and web ports for --backend local', () => {
    expect(androidShotsReversePorts('local')).toEqual([8080, 3000]);
  });

  it('reverses nothing for prod', () => {
    expect(androidShotsReversePorts('prod')).toEqual([]);
  });
});

describe('connectShotsDevClient', () => {
  it('hands the local backend ports to connectDevClient', () => {
    connectShotsDevClient('adb', 'emulator-5554', 'local');
    expect(connectDevClientMock).toHaveBeenCalledWith('adb', 'emulator-5554', [8080, 3000]);
  });

  it('passes no extra ports for prod', () => {
    connectShotsDevClient('adb', 'emulator-5554', 'prod');
    expect(connectDevClientMock).toHaveBeenCalledWith('adb', 'emulator-5554', []);
  });
});

describe('shutdown ports', () => {
  it('stops both Metro and the readiness server', () => {
    expect(ANDROID_SHOTS_SHUTDOWN_PORTS).toEqual([METRO_PORT, SCREENSHOT_READY_PORT]);
  });
});

describe('parseSsListenerPids', () => {
  it('collects unique pids across lines', () => {
    const output = [
      'LISTEN 0 511 *:8097 *:* users:(("node",pid=1234,fd=23),("node",pid=1234,fd=24))',
      'LISTEN 0 511 0.0.0.0:19870 0.0.0.0:* users:(("node",pid=99,fd=20))',
    ].join('\n');
    expect(parseSsListenerPids(output)).toEqual([1234, 99]);
  });

  it('returns nothing for empty output', () => {
    expect(parseSsListenerPids('')).toEqual([]);
  });
});
