// Over-the-air (OTA) preview channel types.
//
// COMPATIBILITY STUB. The in-app per-PR channel switcher this served was
// replaced by xprem Branch Surfing in #4792, which deleted the query outright.
// Store binaries built before that still embed `GetOtaPreviewChannels`, and
// because the switch moved the native fingerprint they can never pull an OTA
// that drops it — their only way off that bundle is a store update. Until that
// tail is gone the field has to keep validating, so the type stays.
//
// Nothing populates it any more: the resolver answers `[]`. See
// docs/mobile-ota-updates.md.

export type OtaPreviewChannel = {
  // The OTA channel name to switch onto, e.g. "pr-3253".
  channel: string;
  // The pull request number.
  prNumber: number;
  // The pull request title, for display.
  title: string;
  // The pull request web URL.
  url: string;
};
