import { Redirect } from 'expo-router';

/**
 * Where `/profile/more` used to be. Settings moved out of the You tab and into a
 * root stack of its own, but www's "open in the app" handoff (the /settings page
 * and the privacy policy's deletion link) has been pointing bookmarks and emails
 * at this URL for releases — so it keeps answering, and forwards.
 *
 * A ROOT route, deliberately, not a stub back inside `(tabs)/profile`: these
 * links mostly land on the Expo web build at app.boardsesh.com (that host is in
 * neither `associatedDomains` nor the Android intent filters, so it opens in a
 * browser, and `+native-intent` never runs on web). A root route answers there
 * and on native alike, and `replace`-ing from one root route to another swaps
 * this screen for Settings cleanly — the same replace fired from inside the tab
 * navigator would target `(tabs)` itself.
 */
export default function LegacySettingsRoute() {
  return <Redirect href="/settings" />;
}
