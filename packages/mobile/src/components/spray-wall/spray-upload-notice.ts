// What the add-a-wall wizard says when the photo cannot go up because the app
// is offline, rather than the generic "The photo didn't make it up." (#5960).
//
// Three different fixes, so three different sentences: Offline mode is a switch
// the climber turned on, no signal is the phone's, and an unreachable backend is
// ours. `useConnectivity().reason` already tells them apart.

import type { ConnectivityReason } from '../../lib/connectivity/connectivity-store';

export type SprayUploadNotice = 'offlineMode' | 'noSignal' | 'serverUnreachable';

export function sprayUploadNotice(reason: ConnectivityReason | null): SprayUploadNotice | null {
  switch (reason) {
    case 'offline_mode':
      return 'offlineMode';
    case 'device_offline':
      return 'noSignal';
    case 'backend_unreachable':
      return 'serverUnreachable';
    default:
      return null;
  }
}
