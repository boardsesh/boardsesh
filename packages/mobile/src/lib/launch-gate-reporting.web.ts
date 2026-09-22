// WEB FORK — the Expo browser export sends no launch-gate evaluation events.
//
// In a browser `Linking.getInitialURL()` is the page's own address, so every
// launch looks like a deep-link launch and says nothing about first runs. See
// the native fork, `launch-gate-reporting.ts`.

/** Whether this build sends the launch-gate evaluation events at all. */
export const REPORTS_LAUNCH_GATE_EVALUATIONS = false;
