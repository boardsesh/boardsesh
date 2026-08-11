import { WEB_BASE_URL } from './env';

// Kiosk/TV management (and general gym setup) is web-only by design; mobile
// hands off to the browser console at /gym/{slug|uuid}/manage. The web route
// resolves either a slug or a uuid, so a slugless legacy gym still reaches
// setup via its uuid. `WEB_BASE_URL` respects the EXPO_PUBLIC_WEB_URL
// override, so it points at whatever web build we're testing.
export function buildGymManageUrl(slugOrUuid: string): string {
  return `${WEB_BASE_URL}/gym/${encodeURIComponent(slugOrUuid)}/manage`;
}
