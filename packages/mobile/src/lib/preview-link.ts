// The `/preview/<channel>` deep link that every PR's OTA-preview comment points
// at (see .github/workflows/mobile-ota-preview.yml, "Announce preview on the
// PR"). It drops a tester straight onto that PR's channel instead of making them
// walk What's New → Try a preview → find the row.
//
// The channel name arrives from a URL, so it is the one channel string the app
// takes from outside itself. Whitelist it here rather than handing it to
// performChannelSwitch raw: only `pr-<number>` (what the preview workflow
// publishes) and the tester presets are accepted. The web half of this contract
// lives in packages/web/app/lib/ota-preview-link.ts.

import { PRESET_CHANNELS } from './channel-switch';

// No leading zeros and no `pr-0`: GitHub numbers PRs from 1, and the web half
// (packages/web/app/lib/ota-preview-link.ts) rejects both, so accepting them here
// would 404 on the page while still switching the app.
const PR_CHANNEL_PATTERN = /^pr-[1-9]\d*$/;

/**
 * Narrow a route param to a channel we're willing to switch onto, or null.
 * Expo Router hands repeated params through as an array, hence the union.
 */
export function parsePreviewChannel(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const channel = value.trim();
  if (PR_CHANNEL_PATTERN.test(channel)) return channel;
  return (PRESET_CHANNELS as readonly string[]).includes(channel) ? channel : null;
}
