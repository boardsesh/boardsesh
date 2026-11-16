import { AppState } from 'react-native';
import * as wifiJoin from '../../../modules/wifi-join/src';
import type { WifiJoinErrorCode } from '../../../modules/wifi-join/src';
import {
  WLED_HOTSPOT_URL,
  WledInstallerError,
  type ControllerLink,
  type InstallerError,
  type InstallerIO,
} from './engine';

/** A stock WLED controller with no Wi-Fi saved opens this hotspot. */
export const WLED_HOTSPOT_SSID = 'WLED-AP';
export const WLED_HOTSPOT_DEFAULT_PASSWORD = 'wled1234';
const WLED_HOTSPOT_HOST = new URL(WLED_HOTSPOT_URL).hostname;

/**
 * What the owner types before joining. A later "name this controller" field
 * (#7553) belongs here too, so it travels with the rest of the hotspot setup.
 */
export type HotspotCredentials = { ssid: string; passphrase: string };

type WifiJoinApi = Pick<typeof wifiJoin, 'join' | 'release' | 'isJoined'>;
export type HotspotLinkDeps = {
  wifi: WifiJoinApi;
  wait(this: void, milliseconds: number, signal: AbortSignal): Promise<void>;
  isForeground(this: void): boolean;
};
export type HotspotLink = ControllerLink & {
  /** True while the OS join prompt may be on screen. Android reports that as backgrounding. */
  isJoining(this: void): boolean;
  isJoined(this: void): boolean;
};

// The first join includes the owner reading and answering the OS prompt.
const JOIN_TIMEOUT_MS = 60_000;
const REJOIN_TIMEOUT_MS = 30_000;
// After a restart Android's still-registered request rebinds on its own, and
// iOS may rejoin a joinOnce network itself. Give that a chance before asking again.
const AUTO_REJOIN_WAIT_MS = 15_000;
const REJOIN_ATTEMPTS = 2;
// A join that lands while the owner has really left the app is undone.
const FOREGROUND_GRACE_MS = 3_000;

const JOIN_ERRORS: Record<WifiJoinErrorCode, InstallerError> = {
  'user-denied': 'hotspotDenied',
  'not-found': 'hotspotNotFound',
  timeout: 'hotspotTimeout',
  'wrong-password': 'hotspotPassword',
  unsupported: 'hotspotUnsupported',
  failed: 'hotspotNotFound',
};
/** Rejoining again would not change these answers. */
const FINAL_JOIN_ERRORS: InstallerError[] = ['hotspotDenied', 'hotspotPassword', 'hotspotUnsupported', 'cancelled'];

export function createHotspotLink(credentials: HotspotCredentials, deps: HotspotLinkDeps): HotspotLink {
  let joining = false;
  async function joinOnce(timeoutMs: number, signal: AbortSignal) {
    if (signal.aborted) throw new WledInstallerError('cancelled');
    joining = true;
    // Cancelling withdraws the OS request, which settles the pending join.
    const withdraw = () => void deps.wifi.release();
    signal.addEventListener('abort', withdraw, { once: true });
    try {
      const result = await deps.wifi.join({
        ssid: credentials.ssid,
        passphrase: credentials.passphrase,
        timeoutMs,
        hostIp: WLED_HOTSPOT_HOST,
      });
      if (signal.aborted) {
        await deps.wifi.release();
        throw new WledInstallerError('cancelled');
      }
      if (!result.joined) throw new WledInstallerError(JOIN_ERRORS[result.error]);
    } finally {
      joining = false;
      signal.removeEventListener('abort', withdraw);
    }
    for (let waited = 0; waited < FOREGROUND_GRACE_MS && !deps.isForeground(); waited += 500) {
      await deps.wait(500, signal);
    }
    if (!deps.isForeground()) {
      await deps.wifi.release();
      throw new WledInstallerError('cancelled');
    }
  }
  return {
    join: (signal) => joinOnce(JOIN_TIMEOUT_MS, signal),
    async ensure(signal) {
      if (deps.wifi.isJoined()) return;
      for (let waited = 0; waited < AUTO_REJOIN_WAIT_MS; waited += 1000) {
        await deps.wait(1000, signal);
        if (deps.wifi.isJoined()) return;
      }
      for (let attempt = 0; attempt < REJOIN_ATTEMPTS; attempt++) {
        try {
          await joinOnce(REJOIN_TIMEOUT_MS, signal);
          return;
        } catch (error) {
          if (!(error instanceof WledInstallerError) || FINAL_JOIN_ERRORS.includes(error.code)) throw error;
        }
      }
      throw new WledInstallerError('hotspotLost');
    },
    release: () => deps.wifi.release(),
    isJoining: () => joining,
    isJoined: () => deps.wifi.isJoined(),
  };
}

function isHotspotUrl(url: string): boolean {
  return url === WLED_HOTSPOT_URL || url.startsWith(`${WLED_HOTSPOT_URL}/`);
}

/**
 * WLED's 4.3.2.1 is a public internet address. A request to it is only sent
 * while the phone is on the hotspot, so it never leaves over mobile data
 * (iOS cannot bind requests to one network; Android can, but drops the
 * binding's network while WLED restarts).
 */
export function hotspotInstallerIO(io: InstallerIO, isJoined: () => boolean): InstallerIO {
  const guard = (url: string) => {
    if (isHotspotUrl(url) && !isJoined()) throw new WledInstallerError('unavailable');
  };
  return {
    ...io,
    async readJson(url, signal) {
      guard(url);
      return io.readJson(url, signal);
    },
    async checkUpdateAccess(url, signal) {
      guard(url);
      return io.checkUpdateAccess(url, signal);
    },
    async upload(url, uri, signal, progress) {
      guard(url);
      return io.upload(url, uri, signal, progress);
    },
  };
}

/** The real link for an owner's phone. */
export function createNativeHotspotLink(credentials: HotspotCredentials, io: InstallerIO): HotspotLink {
  return createHotspotLink(credentials, {
    wifi: wifiJoin,
    wait: io.wait,
    isForeground: () => AppState.currentState === 'active',
  });
}
