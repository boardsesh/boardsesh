import * as Updates from 'expo-updates';
import { OTA_APP_ID } from './ota-app-id';

// Switch the active OTA target by overriding the update request headers, keeping the
// build's update URL (so the embedded code-signing cert still verifies the manifest).
//
// setUpdateRequestHeadersOverride REPLACES the entire baked header set — it does not
// merge — so the override must re-send BOTH headers the build baked: `expo-app-id`
// (the V3 control-plane server 400s "No app id provided" without it — there is no
// legacy fallback) and the target `expo-channel-name`. Sending only the channel would
// silently drop the app id and every manifest/asset request would 400, breaking the
// switch (and the per-PR preview flow that rides it).
//
// Unlike setUpdateURLAndRequestHeadersOverride, this header-only override needs NO
// `disableAntiBrickingMeasures` — expo-updates permits overriding headers baked in at
// build time, and our production builds bake both. It throws if they weren't embedded
// (e.g. EAS-hosted builds); callers catch and surface that. `null` clears the override
// and reverts to the build-time headers.
//
// Used by the separate EAS preview-build branch switcher. Production self-hosted
// previews use xprem's ControlCenter and override `xprem-branch` instead.
export function applyChannelOverride(channel: string | null): void {
  Updates.setUpdateRequestHeadersOverride(
    channel === null ? null : { 'expo-app-id': OTA_APP_ID, 'expo-channel-name': channel },
  );
}
