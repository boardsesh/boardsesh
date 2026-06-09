// First-run onboarding flag: whether the user has seen the mobile welcome
// walkthrough. Written only when the tour is finished or skipped (an interrupted
// tour reshows on next launch). Lives here next to THEME_OVERRIDE_KEY /
// UI_VARIANT_KEY so every user-scoped preference shares one home and a future
// server-side sync can read/write the same slot.
//
// The key uses only [\w.-] so it satisfies expo-secure-store's validator
// (anything with `:` or other punctuation throws at the platform boundary).

export const ONBOARDING_SEEN_KEY = 'onboarding_seen';
