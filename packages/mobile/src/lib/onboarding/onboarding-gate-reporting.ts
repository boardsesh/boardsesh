// NATIVE FORK — `Onboarding Gate Evaluated` reports from the store fleet.
//
// `onboarding-gate-reporting.web.ts` is the fork Metro picks for the Expo
// browser export, and it turns the event off. In a browser
// `Linking.getInitialURL()` returns the page's own address, so every web launch
// would decide `skipped / launched_by_url` and pad the `reason` breakdown the
// first-run change sizes its audience from. PostHog cannot filter those out
// afterwards: the browser build runs the same `posthog-react-native` client,
// so `$lib` is the same on both.

/** Whether this build sends `Onboarding Gate Evaluated` at all. */
export const REPORTS_ONBOARDING_GATE_EVALUATIONS = true;
