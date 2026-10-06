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
// One-shot tip for new accounts on iOS 26 Liquid Glass iPhones, where Climbs is
// the tab bar's search-role magnifier (#5654): shown the first time another tab
// is open, pointing back to the magnifier. Written as soon as it shows.
export const ONBOARDING_TIP_CLIMBS_TAB_KEY = 'onboarding_tip_climbs_tab_seen';
// The spray-wall hold editor's first-run hints, each marked seen when the
// climber does the thing it teaches (or closes it), never merely on showing:
// tapping a ring to pick it and again to switch it, keeping a dashed maybe,
// pressing and holding a ring to move it, and (asked for by a tap on bare wall)
// where adding a hold lives.
//
// The tap hint has its own key, not the old `onboarding_tip_spray_toggle_seen`:
// a tap used to switch a ring outright and now only picks it, so a climber who
// learned the old rule has to see the new one once. The old key is no longer
// read or written; a value left behind on a device is inert.
export const ONBOARDING_TIP_SPRAY_TAP_SELECT_KEY = 'onboarding_tip_spray_tap_select_seen';
export const ONBOARDING_TIP_SPRAY_MAYBE_KEY = 'onboarding_tip_spray_maybe_seen';
export const ONBOARDING_TIP_SPRAY_LONG_PRESS_KEY = 'onboarding_tip_spray_long_press_seen';
export const ONBOARDING_TIP_SPRAY_ADD_HOLD_KEY = 'onboarding_tip_spray_add_hold_seen';

// Dismissal of the "your board account isn't linked" card on the empty Progress /
// Logbook tabs. Not a tip: an empty logbook with no linked account is a standing
// true condition rather than a one-time thing to teach, so only an explicit dismiss
// hides it — it is not consumed on first render like the banners above.
export const ONBOARDING_LINK_EMPTY_DISMISSED_KEY = 'onboarding_link_empty_dismissed';
