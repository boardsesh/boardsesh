// First-run onboarding flag: whether the user has seen the mobile welcome
// walkthrough. Written only when the tour is finished or skipped (an interrupted
// tour reshows on next launch). Lives here next to THEME_OVERRIDE_KEY /
// UI_VARIANT_KEY so every user-scoped preference shares one home and a future
// server-side sync can read/write the same slot.
//
// The key uses only [\w.-] so it satisfies expo-secure-store's validator
// (anything with `:` or other punctuation throws at the platform boundary).

export const ONBOARDING_SEEN_KEY = 'onboarding_seen';

// One-shot "show the board-history reveal banner on Climbs" flag. Set when the
// user binds their first board from the onboarding handoff; consumed (read +
// cleared) the first time the Climbs landing renders the banner. Separate from
// ONBOARDING_SEEN_KEY so the prompt still shows exactly once while this banner
// fires only after an actual board bind.
export const ONBOARDING_BOARD_TIP_KEY = 'onboarding_board_tip_pending';

// Just-in-time feature tips, each shown once on the surface where the feature
// lives. Boolean-true means seen. Keys use only [\w.-] for expo-secure-store.
export const ONBOARDING_TIP_WORKOUT_KEY = 'onboarding_tip_workout_seen';
export const ONBOARDING_TIP_CREW_KEY = 'onboarding_tip_crew_seen';
export const ONBOARDING_TIP_RECORD_KEY = 'onboarding_tip_record_seen';
// One-shot tip for the bottom accessory bar (current-climb / queue platter):
// teaches that the bar always mirrors what's on the wall. Fires the first time a
// current climb exists (so the bar is on screen), then never again.
export const ONBOARDING_TIP_ACCESSORY_KEY = 'onboarding_tip_accessory_seen';
// One-shot tip on the Climbs list teaching the quick-actions menu: long-press a
// climb (or tap the ⋯ button) for queue / tick / playlists and more. Fires once,
// after the board-reveal banner has had its turn.
export const ONBOARDING_TIP_QUICKACTIONS_KEY = 'onboarding_tip_quickactions_seen';

// The one-time "pick your board look" step (2.4, when the Boardsesh drawing
// became the app default). Shown once to a climber who has never chosen a
// render mode; skipping counts, so a climber is asked exactly once either way.
// Deliberately NOT written when the installed binary can't draw the Boardsesh
// mode — there is no real choice to make on that build, so they get asked after
// they update instead.
export const BOARD_LOOK_STEP_SEEN_KEY = 'board_look_step_seen';
