// The SecureStore key for the user's explicit language choice, split out from
// locale-preference.ts so it can be read without that module's graph.
//
// preference-secure-keys.ts needs this literal to decide what the #4103 keychain
// migration covers, and locale-preference.ts reaches i18next, react-i18next and
// the whole catalog set through ./config. Importing the key from there would
// drag all of it — including react-native's Flow entry, which Rolldown parses at
// collection time — into any graph that only wanted a string.
//
// The key uses only [\w.-] to satisfy expo-secure-store's validator (`:` and
// other punctuation throw at the platform boundary), matching
// THEME_OVERRIDE_KEY's constraint.

export const LOCALE_OVERRIDE_KEY = 'locale_override';
