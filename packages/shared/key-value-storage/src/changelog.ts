// "What's New" changelog last-seen marker: the ISO `mergedAt` of the newest
// changelog entry the user has already viewed. Written when the changelog screen
// mounts; compared against the bundled changelog's latest entry to decide whether
// the More tab shows a "New" pill. Lives here next to THEME_OVERRIDE_KEY /
// ONBOARDING_SEEN_KEY so every user-scoped preference shares one home.
//
// The key uses only [\w.-] so it satisfies expo-secure-store's validator
// (anything with `:` or other punctuation throws at the platform boundary).

export const CHANGELOG_LAST_SEEN_KEY = 'changelog_last_seen';
