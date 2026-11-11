using Toybox.Lang;

// Pure transitions for ONE persisted auth value. A tombstone is never deleted.
// Number exhaustion refuses transitions instead of wrapping/reusing a scope.
// No cross-key or power-loss atomicity is assumed.
module AuthState {
    const VERSION = 2;
    const MAX_COUNTER = 2147483646;

    function nonempty(candidate) as Lang.Boolean {
        return candidate instanceof Lang.String && candidate.length() > 0 && candidate.length() <= 4096;
    }

    function counter(candidate) as Lang.Boolean {
        return candidate instanceof Lang.Number && candidate >= 0 && candidate <= MAX_COUNTER;
    }

    function statusIs(state, expected as Lang.String) as Lang.Boolean {
        return state instanceof Lang.Dictionary && state["status"] instanceof Lang.String && state["status"].equals(expected);
    }
    function sameOwner(first, second) as Lang.Boolean {
        if (first == null || second == null) { return first == null && second == null; }
        return first instanceof Lang.String && second instanceof Lang.String && first.equals(second);
    }

    function valid(state) as Lang.Boolean {
        if (!(state instanceof Lang.Dictionary) || state["version"] != VERSION ||
                !counter(state["scope"]) || !counter(state["revision"])) { return false; }
        if (statusIs(state, "empty")) {
            return state["owner"] == null && state["jwt"] == null && state["refresh"] == null && state["expires"] == null;
        }
        if (!statusIs(state, "active") && !statusIs(state, "bootstrap") && !statusIs(state, "rotating")) { return false; }
        if (statusIs(state, "active") && !nonempty(state["owner"])) { return false; }
        if (statusIs(state, "bootstrap") && state["owner"] != null) { return false; }
        if (state["owner"] != null && (!nonempty(state["owner"]) ||
                state["owner"].length() > 256 || state["scope"] == 0)) { return false; }
        return nonempty(state["jwt"]) && nonempty(state["refresh"]) && nonempty(state["expires"]);
    }

    function empty(scope, revision) {
        return { "version" => VERSION, "scope" => scope, "revision" => revision,
            "status" => "empty", "owner" => null, "jwt" => null, "refresh" => null, "expires" => null };
    }

    // Only a truly absent V2 value permits migration. Invalid V2 is NOT absent.
    function bootstrap(jwt, refresh, expires) {
        if (!nonempty(jwt) || !nonempty(refresh) || !nonempty(expires)) { return empty(0, 0); }
        return { "version" => VERSION, "scope" => 0, "revision" => 0,
            "status" => "bootstrap", "owner" => null, "jwt" => jwt, "refresh" => refresh, "expires" => expires };
    }

    function sameScope(first, second) as Lang.Boolean {
        return valid(first) && valid(second) && first["scope"] == second["scope"] && sameOwner(first["owner"], second["owner"]);
    }

    function sameRevision(first, second) as Lang.Boolean {
        return sameScope(first, second) && first["revision"] == second["revision"] && first["status"].equals(second["status"]);
    }

    function clear(state) {
        if (!valid(state) || state["scope"] >= MAX_COUNTER || state["revision"] >= MAX_COUNTER) { return null; }
        return empty(state["scope"] + 1, state["revision"] + 1);
    }

    // Persist BEFORE consuming the single-use refresh secret. A restart in this
    // state requires re-pairing; it never retries an ambiguously consumed secret.
    function beginRotation(state) {
        if (!valid(state) || (!AuthState.statusIs(state, "active") && !AuthState.statusIs(state, "bootstrap")) ||
                state["revision"] >= MAX_COUNTER) { return null; }
        return { "version" => VERSION, "scope" => state["scope"], "revision" => state["revision"] + 1,
            "status" => "rotating", "owner" => state["owner"], "jwt" => state["jwt"],
            "refresh" => state["refresh"], "expires" => state["expires"] };
    }

    // Caller must prove no server consumption (a pre-send refusal or an
    // existing endpoint response whose path precedes/rolls back the TX).
    function resumeUnconsumed(state) {
        if (!valid(state) || !statusIs(state, "rotating") || state["revision"] >= MAX_COUNTER) { return null; }
        return { "version" => VERSION, "scope" => state["scope"], "revision" => state["revision"] + 1,
            "status" => state["owner"] == null ? "bootstrap" : "active", "owner" => state["owner"],
            "jwt" => state["jwt"], "refresh" => state["refresh"], "expires" => state["expires"] };
    }

    function canUseAccess(state) as Lang.Boolean {
        return valid(state) && state["owner"] != null && (statusIs(state, "active") || statusIs(state, "rotating"));
    }

    function responseValid(response) as Lang.Boolean {
        return response instanceof Lang.Dictionary && nonempty(response["userId"]) &&
            response["userId"].length() <= 256 && nonempty(response["jwt"]) &&
            nonempty(response["refreshToken"]) && nonempty(response["expiresAt"]);
    }

    function accept(state, response, pairing as Lang.Boolean) {
        if (!valid(state) || !responseValid(response) || state["revision"] >= MAX_COUNTER) { return null; }
        if (!pairing && !AuthState.statusIs(state, "rotating")) { return null; }
        if (!pairing && state["owner"] != null && !sameOwner(state["owner"], response["userId"])) { return null; }
        // A verified bootstrap binds ONLY these credentials in a NEW scope.
        var newScope = state["scope"];
        if (pairing || state["owner"] == null) {
            if (newScope >= MAX_COUNTER) { return null; }
            newScope += 1;
        }
        return { "version" => VERSION, "scope" => newScope, "revision" => state["revision"] + 1,
            "status" => "active", "owner" => response["userId"], "jwt" => response["jwt"],
            "refresh" => response["refreshToken"], "expires" => response["expiresAt"] };
    }
}
