using Toybox.Lang;

// Cross-cutting session state singleton.
//
// Holds the currently attached sessionId, the last slim state payload from
// /api/session/state and the navigation generation used to reject stale poll
// callbacks while a navigate + authoritative refresh is in flight.
module AppState {
    // Lang.String or Null — the attached multiplayer session id.
    var sessionId = null;
    // Lang.String or Null — human label for the session (from mySessions).
    var sessionName = null;
    // Lang.Dictionary or Null — last parsed slim state payload.
    var state = null;
    // Millis (System.getTimer()) until which the optimistic index is trusted.
    var optimisticUntilMs = 0;
    // Lang.Number or Null — the index we optimistically navigated to.
    var optimisticIndex = null;
    // Monotonic generation captured by every state request. Starting/cancelling
    // navigation invalidates callbacks created against an older climb.
    var stateGeneration = 0;
    var navigationPending = false;
    var navigationAccepted = false;
    var navigationRefreshInFlight = false;
    var navigationOriginalIndex = null;
    // Whether the last poll succeeded (drives the offline banner).
    var online = true;

    // Attach (or switch to) a session. Called from LoadingView and the session
    // picker. `id`/`name` are the opaque values from mySessions (used as-is), so
    // typed permissively. NOTE: the per-session climb log (SessionLog) is NOT
    // reset here — it is tied to the FIT recording's lifetime instead (reset in
    // ActivityController.startIfNeeded when a new recording begins). Switching
    // Boardsesh sessions mid-climb keeps one continuous FIT activity, so the log
    // must keep accumulating to stay consistent with the recorded laps.
    function attachSession(id as Lang.Object or Null, name as Lang.Object or Null) as Void {
        sessionId = id;
        sessionName = name;
        state = null;
        stateGeneration += 1;
        navigationPending = false;
        navigationAccepted = false;
        navigationRefreshInFlight = false;
        navigationOriginalIndex = null;
        clearOptimistic();
    }

    // Shared by initial loading and the explicit session switcher.
    function activeSessions(sessions) as Lang.Array {
        var active = [];
        if (!(sessions instanceof Lang.Array)) { return active; }
        for (var index = 0; index < sessions.size(); index += 1) {
            var session = sessions[index];
            if (session instanceof Lang.Dictionary && session["isActive"] == true) {
                active.add(session);
            }
        }
        return active;
    }

    function currentIndex() as Lang.Number {
        if (state == null) { return 0; }
        var idx = state["currentIndex"];
        return (idx == null) ? 0 : idx;
    }

    function queueLength() as Lang.Number {
        if (state == null) { return 0; }
        var len = state["queueLength"];
        return (len == null) ? 0 : len;
    }

    // Display only: stale optimistic indexes cannot exceed a shrinking queue.
    function queuePosition() as Lang.Number {
        var total = queueLength();
        if (total <= 0) { return 0; }
        var position = currentIndex() + 1;
        if (position < 1) { return 1; }
        return position > total ? total : position;
    }

    function climb() as Lang.Dictionary or Null {
        if (state == null) { return null; }
        return state["climb"];
    }

    // Begin an optimistic navigation: reflect the new index locally right away
    // and open the reconciliation window.
    function beginOptimistic(newIndex as Lang.Number, nowMs as Lang.Number) as Void {
        optimisticIndex = newIndex;
        optimisticUntilMs = nowMs + BuildConfig.OPTIMISTIC_WINDOW_MS;
        if (state != null) {
            state["currentIndex"] = newIndex;
        }
    }

    // PURE wraparound index used by both next and previous navigation.
    function wrappedIndex(current as Lang.Number, total as Lang.Number, action as Lang.String) as Lang.Number {
        if (total <= 0) { return 0; }
        if (action.equals("next")) {
            return (current + 1) % total;
        }
        return (current + total - 1) % total;
    }

    function beginNavigation(newIndex as Lang.Number, nowMs as Lang.Number) as Lang.Number {
        stateGeneration += 1;
        navigationPending = true;
        navigationAccepted = false;
        navigationRefreshInFlight = false;
        navigationOriginalIndex = currentIndex();
        beginOptimistic(newIndex, nowMs);
        return stateGeneration;
    }

    function markNavigationAccepted() as Void {
        navigationAccepted = true;
    }

    function beginNavigationRefresh() as Void {
        navigationRefreshInFlight = true;
    }

    function endNavigationRefresh() as Void {
        navigationRefreshInFlight = false;
    }

    function completeNavigation(newState as Lang.Dictionary) as Void {
        state = newState;
        navigationPending = false;
        navigationAccepted = false;
        navigationRefreshInFlight = false;
        navigationOriginalIndex = null;
        clearOptimistic();
    }

    function cancelNavigation() as Void {
        if (state != null && navigationOriginalIndex != null) {
            state["currentIndex"] = navigationOriginalIndex;
        }
        stateGeneration += 1;
        navigationPending = false;
        navigationAccepted = false;
        navigationRefreshInFlight = false;
        navigationOriginalIndex = null;
        clearOptimistic();
    }

    // PURE callback-generation guard. A response may mutate visible state only
    // if no navigation/session transition has invalidated its request.
    function acceptsStateGeneration(generation as Lang.Number) as Lang.Boolean {
        return generation == stateGeneration;
    }

    // Cancel any outstanding optimistic window (server index wins on next poll).
    function clearOptimistic() as Void {
        optimisticUntilMs = 0;
        optimisticIndex = null;
    }

    // PURE reconciliation decision, extracted for unit testing.
    //
    // Given an outstanding optimistic navigation and a freshly polled server
    // index, decide whether to ACCEPT the server index (return true) or keep
    // the optimistic index (return false):
    //   * window elapsed        -> accept (server always wins afterwards)
    //   * server already agrees -> accept (settled early)
    //   * inside window, differs -> ignore, keep optimistic
    function acceptPollIndex(
        optimisticUntil as Lang.Number,
        optimisticIdx as Lang.Number or Null,
        pollIndex as Lang.Number,
        nowMs as Lang.Number
    ) as Lang.Boolean {
        if (optimisticIdx == null) {
            return true;
        }
        // Number subtraction wraps with System.getTimer(). Comparing the
        // bounded deadline delta works even when the signed timer rolls over.
        if (nowMs - optimisticUntil >= 0) {
            return true;
        }
        if (pollIndex == optimisticIdx) {
            return true;
        }
        return false;
    }
}
