// The party profile is a per-device anonymous identity (a single UUID) that
// predates auth and survives sign-out. It seeds the WebSocket-party display
// name and gives mobile a stable peer identity even when the user hasn't
// signed in. It is not a PostHog id on either platform: analytics uses the
// SDK's own anonymous id.
//
// Each platform brings its own persistence: web stores it in IndexedDB,
// mobile in expo-secure-store. The platform-specific storage adapter is
// injected into `ensureProfile` so this package stays pure TS.

export type { PartyProfile, PartyProfileStorage } from './types';
export { ensureProfile } from './ensure-profile';
