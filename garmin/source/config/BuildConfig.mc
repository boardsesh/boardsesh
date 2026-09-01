using Toybox.Lang;

// Build-time configuration.
//
// The backend base URL is selected by build flavor (see monkey.jungle):
//   * the base/default flavor keeps the (:production) baseUrl() and strips
//     the (:staging) one (base.excludeAnnotations = staging).
//   * the `staging` flavor does the opposite (staging.excludeAnnotations =
//     production), swapping in the staging host.
// Annotating two same-named functions and excluding one per flavor guarantees
// exactly one baseUrl() compiles, so callers just use BuildConfig.baseUrl().
module BuildConfig {

    (:production)
    function baseUrl() as Lang.String {
        return "https://ws.boardsesh.com";
    }

    (:staging)
    function baseUrl() as Lang.String {
        // Placeholder — set this to YOUR staging / LAN backend before a
        // `--flavor staging` build. Deliberately a non-real host so a staging
        // build can't accidentally send traffic to production or an assumed host.
        return "https://your-staging-host.example";
    }

    // Foreground poll cadence for /api/session/state.
    const POLL_INTERVAL_MS = 3000;

    // Exponential backoff for polling errors: 3s -> 6s -> 12s -> ... capped.
    const POLL_BACKOFF_CAP_MS = 30000;

    // Optimistic navigation reconciliation window: after a next/previous we
    // trust our local index for this long before the server index wins.
    const OPTIMISTIC_WINDOW_MS = 1500;

    // Bounded offline tick queue (drop-oldest when full).
    const TICK_QUEUE_MAX = 25;
}
