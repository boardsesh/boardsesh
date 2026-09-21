// WEB FORK — the Expo browser export sends no `Onboarding Gate Evaluated`.
//
// In a browser `Linking.getInitialURL()` is the page's own address, so every
// launch reads as `launched_by_url` and says nothing about first runs. See the
// native fork, `onboarding-gate-reporting.ts`.

/** Whether this build sends `Onboarding Gate Evaluated` at all. */
export const REPORTS_ONBOARDING_GATE_EVALUATIONS = false;
