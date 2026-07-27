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

/**
 * Pull the channel out of a preview link, or null if it isn't one. Handles every
 * shape that reaches the app: the universal link
 * `https://www.boardsesh.com/preview/pr-1234` (with an optional `/es` locale
 * prefix), and the custom scheme in both spellings
 * (`com.boardsesh.app://preview/…` and `:///preview/…`).
 *
 * Hand-rolled rather than built on `Linking.parse`, for the same reason
 * `deep-link-query.ts` avoids it: expo-linking pulls in react-native, so a parser
 * that touches it can't be unit-tested in a node environment. The URL shapes here
 * are ours and narrow.
 */
export function parsePreviewLinkChannel(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Drop the scheme, then any query/hash tail.
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const pathOnly = withoutScheme.split(/[?#]/)[0];

  const segments = pathOnly
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  // For an https link the first segment is the domain; for the custom scheme's
  // two-slash form it's already `preview`. A dot only ever appears in a host.
  if (segments.length > 0 && segments[0].includes('.')) segments.shift();
  // Drop a leading two-letter locale (`es`, `fr`) — no route prefix is 2 letters.
  if (segments.length > 0 && /^[a-z]{2}$/.test(segments[0])) segments.shift();

  if (segments.length < 2 || segments[0] !== 'preview') return null;
  return parsePreviewChannel(segments[1]);
}
