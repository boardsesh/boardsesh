import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Why a join did not happen. Android reports a refused prompt, a hotspot out of
 * range and a wrong password the same way (`not-found`); iOS tells a refusal
 * apart (`user-denied`) and rejects a malformed password up front.
 */
export type WifiJoinErrorCode = 'user-denied' | 'not-found' | 'timeout' | 'unsupported' | 'wrong-password' | 'failed';

export type WifiJoinOptions = {
  ssid: string;
  /** Empty or omitted for an open network. WPA2 passwords are 8 to 63 characters. */
  passphrase?: string;
  timeoutMs: number;
  /**
   * The device's address on its own network, e.g. WLED's `4.3.2.1`. On iOS the
   * join only counts once the phone's Wi-Fi has an address on the same /24, so a
   * request to this host can never leave over mobile data.
   */
  hostIp: string;
};

export type WifiJoinResult = { joined: true } | { joined: false; error: WifiJoinErrorCode };

type WifiJoinNativeModule = {
  join(
    ssid: string,
    passphrase: string | null,
    timeoutMs: number,
    hostIp: string,
  ): Promise<{ joined: boolean; error?: string }>;
  release(): Promise<void>;
  isJoined(): boolean;
};

const ERROR_CODES: readonly WifiJoinErrorCode[] = [
  'user-denied',
  'not-found',
  'timeout',
  'unsupported',
  'wrong-password',
  'failed',
];
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

// Optional resolution keeps binaries built before this module, and Expo Go,
// working: every call then reports `unsupported` and the owner joins by hand.
const nativeModule = requireOptionalNativeModule<WifiJoinNativeModule>('WifiJoin');

function invalidOptions({ ssid, passphrase, hostIp }: WifiJoinOptions): WifiJoinErrorCode | null {
  const ssidBytes = new TextEncoder().encode(ssid).length;
  if (ssidBytes === 0 || ssidBytes > 32 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostIp)) return 'failed';
  if (passphrase && (passphrase.length < 8 || passphrase.length > 63)) return 'wrong-password';
  return null;
}

/**
 * Asks the OS to join a device's own hotspot and routes this app's requests to
 * it. Android 10+ shows a system prompt and binds the app's process to that
 * network; iOS shows its "Join Wi-Fi network" alert. Always pair with
 * `release()`: a binding left behind cuts the app off from the internet.
 */
export async function join(options: WifiJoinOptions): Promise<WifiJoinResult> {
  if (!nativeModule) return { joined: false, error: 'unsupported' };
  const invalid = invalidOptions(options);
  if (invalid) return { joined: false, error: invalid };
  const timeoutMs = Math.round(Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs)));
  try {
    const result = await nativeModule.join(options.ssid, options.passphrase || null, timeoutMs, options.hostIp);
    if (result.joined) return { joined: true };
    const error = ERROR_CODES.find((code) => code === result.error) ?? 'failed';
    return { joined: false, error };
  } catch {
    return { joined: false, error: 'failed' };
  }
}

/** Leaves the hotspot and restores normal routing. Safe to call any number of times. */
export async function release(): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.release();
  } catch {
    // Releasing is best effort and idempotent; the native side also releases on teardown.
  }
}

/** True while the joined hotspot is up and this app's requests go to it. */
export function isJoined(): boolean {
  if (!nativeModule) return false;
  try {
    return nativeModule.isJoined();
  } catch {
    return false;
  }
}
