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

    // Bounded owned tick queue (refuse new logs when full).
    const TICK_QUEUE_MAX = 25;

    // Dead-letter store for ticks the server refused for good. 25 entries is
    // about 15KB of the separate 32KB storage value. Nothing is ever evicted:
    // when full, the next refusal stays queued and the drain stops there.
    const REJECTED_TICK_MAX = 25;

    // Retry all moves at most this many refused ticks per press, and never
    // into the last REFUSED_RETRY_HEADROOM queue slots. A drain dead-letters
    // only one tick per refusal reason, so a batch the server still refuses
    // must not be able to fill the queue and block new logs.
    const REFUSED_RETRY_BATCH = 5;
    const REFUSED_RETRY_HEADROOM = 5;

    // A pre-G2 tick is adopted only when logged at least this long after the
    // old app's final access token was issued: one day covers a watch clock
    // set fast by a wrong time zone (at most 14h) with room to spare.
    const LEGACY_ADOPT_SKEW_SEC = 86400;
}
