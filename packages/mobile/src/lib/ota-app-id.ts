// The expo-open-ota (V3 control-plane) app id the self-hosted server routes on. It
// is sent as the `expo-app-id` request header on every manifest/asset request — the
// V3 server returns 400 ("No app id provided") without it, as there is no legacy
// fallback. This is NOT the EAS project id (that value is only the code-signing
// cert's CN). Single source of truth, shared by:
//   • app.config.ts — bakes the header into the binary at build time, and
//   • apply-channel-override.ts — the in-app switcher, which must re-send it because
//     setUpdateRequestHeadersOverride REPLACES the header set rather than merging.
// Overridable via EXPO_PUBLIC_OTA_APP_ID only if the app is ever re-provisioned
// (it's a fingerprint input, so keep it stable across a binary's lifetime).
export const OTA_APP_ID = process.env.EXPO_PUBLIC_OTA_APP_ID ?? '007e6fd7-f200-448c-9449-8d48ba5d51fc';
