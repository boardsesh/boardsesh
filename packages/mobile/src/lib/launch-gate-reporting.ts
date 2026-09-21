// NATIVE FORK — the launch-gate evaluation events report from the store fleet.
//
// `launch-gate-reporting.web.ts` is the fork Metro picks for the Expo browser
// export, and it turns both events off: `Onboarding Gate Evaluated` and
// `Board Look Step Evaluated`. In a browser `Linking.getInitialURL()` returns
// the page's own address, so every web launch looks like a deep-link launch.
// The onboarding gate would decide `skipped / launched_by_url` every time, and
// the board-look gate could only ever settle on `look_chosen`, which skews both
// breakdowns the first-run change sizes its audience from. PostHog cannot
// filter those out afterwards: the browser build runs the same
// `posthog-react-native` client, so `$lib` is the same on both.

/** Whether this build sends the launch-gate evaluation events at all. */
export const REPORTS_LAUNCH_GATE_EVALUATIONS = true;
