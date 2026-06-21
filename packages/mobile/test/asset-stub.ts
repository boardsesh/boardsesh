// Static image assets resolve to a Metro asset id (a number) at runtime. Under
// Vitest there is no Metro asset pipeline and the binary can't be parsed as a
// module, so any suite that transitively imports an asset (e.g. onboarding-cards
// → assets/onboarding/board-history.png) is redirected here by the vite.config
// alias — BEFORE Rolldown reads the binary. A dummy default mimics the asset ref.
export default 1;
