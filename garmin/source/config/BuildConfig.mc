using Toybox.Lang;

// Build-time configuration.
//
// The default jungle excludes (:staging). Adding monkey-staging.jungle to
// the -f jungle list instead excludes (:production). Exactly one baseUrl()
// compiles. Named --flavor options are not supported by monkeyc.
module BuildConfig {

    (:production)
    function baseUrl() as Lang.String {
        return "https://ws.boardsesh.com";
    }

    (:staging)
    function baseUrl() as Lang.String {
        // Placeholder — set this to YOUR staging / LAN backend before a
        // staging jungle build. Deliberately a non-real host so a staging
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
