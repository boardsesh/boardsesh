// The web half of the OTA-preview deep link. Every PR that publishes a preview
// channel gets a comment linking to /preview/<channel> (see
// .github/workflows/mobile-ota-preview.yml). On iOS that URL opens the app
// directly through the wildcard AASA; everywhere else it lands on the web page
// under app/preview/[channel], which offers the custom-scheme link instead.
//
// The mobile half is packages/mobile/src/lib/preview-link.ts. The two are kept
// deliberately small and separate rather than shared, because the third consumer
// of this grammar — the github-script step in the workflow — can't import TS at
// all. Keep the pattern below in sync with PR_CHANNEL_PATTERN over there.

const PR_CHANNEL_PATTERN = /^pr-(\d+)$/;

/** The app's custom URL scheme, from packages/mobile/app.config.ts. */
const APP_SCHEME = 'com.boardsesh.app';

/**
 * The PR number behind a `pr-<number>` preview channel, or null if the string
 * isn't one. Doubles as the route's validity check.
 */
export function previewPullRequestNumber(channel: string): number | null {
  const match = PR_CHANNEL_PATTERN.exec(channel.trim());
  if (!match) return null;
  const pullNumber = Number(match[1]);
  return Number.isSafeInteger(pullNumber) && pullNumber > 0 ? pullNumber : null;
}

/**
 * The scheme link that opens the channel switcher in an installed app. Three
 * slashes is the shape `Linking.createURL()` emits — the two-slash spelling puts
 * `preview` in the URL host, which Expo Router's prefix stripping drops.
 * (+native-intent.ts normalises both, but emit the form that needs no rescue.)
 */
export function buildAppPreviewLink(channel: string): string {
  return `${APP_SCHEME}:///preview/${channel}`;
}
