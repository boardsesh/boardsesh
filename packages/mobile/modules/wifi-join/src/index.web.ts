import type { WifiJoinOptions, WifiJoinResult } from './index';

export type { WifiJoinErrorCode, WifiJoinOptions, WifiJoinResult } from './index';

/** A browser cannot join a Wi-Fi network; the installer stays on Android and iOS. */
export async function join(_options: WifiJoinOptions): Promise<WifiJoinResult> {
  return { joined: false, error: 'unsupported' };
}

export async function release(): Promise<void> {}

export function isJoined(): boolean {
  return false;
}
