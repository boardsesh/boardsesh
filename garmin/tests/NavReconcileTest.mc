using Toybox.Test;
using Toybox.Lang;

// Tests for the optimistic-navigation reconciliation decision
// (AppState.acceptPollIndex). true = accept the server index; false = keep the
// local optimistic index.

(:test)
function testWindowElapsedServerWins(logger as Test.Logger) as Lang.Boolean {
    // now == until -> window over -> accept.
    Test.assertEqual(AppState.acceptPollIndex(1000, 3, 5, 1000), true);
    // now > until -> accept.
    Test.assertEqual(AppState.acceptPollIndex(1000, 3, 5, 2000), true);
    return true;
}

(:test)
function testInsideWindowServerAgrees(logger as Test.Logger) as Lang.Boolean {
    // Inside the window but the server already matches our optimistic index.
    Test.assertEqual(AppState.acceptPollIndex(5000, 3, 3, 1000), true);
    return true;
}

(:test)
function testInsideWindowServerDisagrees(logger as Test.Logger) as Lang.Boolean {
    // Inside the window and the server disagrees -> keep optimistic (ignore).
    Test.assertEqual(AppState.acceptPollIndex(5000, 3, 5, 1000), false);
    return true;
}

(:test)
function testNoOptimisticIndexAlwaysAccepts(logger as Test.Logger) as Lang.Boolean {
    // No outstanding optimistic nav -> always accept the server index.
    Test.assertEqual(AppState.acceptPollIndex(5000, null, 5, 1000), true);
    return true;
}

(:test)
function testOptimisticWindowCrossesTimerRollover(logger as Test.Logger) as Lang.Boolean {
    var deadline = -2147483049;
    Test.assertEqual(AppState.acceptPollIndex(deadline, 3, 5, 2147483547), false);
    Test.assertEqual(AppState.acceptPollIndex(deadline, 3, 5, -2147483349), false);
    Test.assertEqual(AppState.acceptPollIndex(deadline, 3, 5, deadline), true);
    Test.assertEqual(AppState.acceptPollIndex(deadline, 3, 5, -2147482949), true);
    return true;
}

(:test)
function testQueuePositionStaysInsideBounds(logger as Test.Logger) as Lang.Boolean {
    AppState.state = { "currentIndex" => 4, "queueLength" => 3 };
    Test.assertEqual(AppState.queuePosition(), 3);
    AppState.state = { "currentIndex" => -4, "queueLength" => 3 };
    Test.assertEqual(AppState.queuePosition(), 1);
    AppState.state = { "currentIndex" => 0, "queueLength" => 0 };
    Test.assertEqual(AppState.queuePosition(), 0);
    AppState.state = null;
    return true;
}

(:test)
function testSwitchingSessionsClearsOldQueueAndOptimisticState(logger as Test.Logger) as Lang.Boolean {
    AppState.state = { "currentIndex" => 4, "queueLength" => 5 };
    AppState.beginOptimistic(4, 1000);
    AppState.attachSession("next-session", "Next");
    Test.assertEqual(AppState.state == null, true);
    Test.assertEqual(AppState.optimisticIndex == null, true);
    Test.assertEqual(AppState.acceptPollIndex(AppState.optimisticUntilMs, AppState.optimisticIndex, 0, -100), true);
    AppState.sessionId = null;
    AppState.sessionName = null;
    return true;
}

(:test)
function testActiveSessionFilterHandlesMalformedEntries(logger as Test.Logger) as Lang.Boolean {
    var sessions = AppState.activeSessions([
        null, "invalid", { "id" => "ended", "isActive" => false },
        { "id" => "active", "isActive" => true }
    ]);
    Test.assertEqual(sessions.size(), 1);
    Test.assertEqual(sessions[0]["id"], "active");
    Test.assertEqual(AppState.activeSessions("invalid response").size(), 0);
    return true;
}

(:test)
function testNavigationWrapsAtBothQueueBoundaries(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(AppState.wrappedIndex(4, 5, "next"), 0);
    Test.assertEqual(AppState.wrappedIndex(0, 5, "previous"), 4);
    Test.assertEqual(AppState.wrappedIndex(2, 5, "next"), 3);
    Test.assertEqual(AppState.wrappedIndex(2, 5, "previous"), 1);
    Test.assertEqual(AppState.wrappedIndex(0, 0, "next"), 0);
    return true;
}

(:test)
function testNavigationGenerationInvalidatesStaleCallbacks(logger as Test.Logger) as Lang.Boolean {
    AppState.state = { "currentIndex" => 1, "queueLength" => 3 };
    var oldGeneration = AppState.stateGeneration;
    var navigationGeneration = AppState.beginNavigation(2, 1000);
    Test.assertEqual(AppState.navigationPending, true);
    Test.assertEqual(AppState.acceptsStateGeneration(oldGeneration), false);
    Test.assertEqual(AppState.acceptsStateGeneration(navigationGeneration), true);
    AppState.cancelNavigation();
    Test.assertEqual(AppState.currentIndex(), 1);
    Test.assertEqual(AppState.navigationPending, false);
    Test.assertEqual(AppState.acceptsStateGeneration(navigationGeneration), false);
    AppState.state = null;
    return true;
}

(:test)
function testNavigationStaysBlockedUntilAuthoritativeState(logger as Test.Logger) as Lang.Boolean {
    AppState.state = { "currentIndex" => 1, "queueLength" => 3 };
    AppState.beginNavigation(2, 1000);
    AppState.markNavigationAccepted();
    AppState.beginNavigationRefresh();
    Test.assertEqual(AppState.navigationPending, true);
    Test.assertEqual(AppState.navigationRefreshInFlight, true);

    // A failed direct GET yields to PollController but must not expose the old
    // climb to logging/navigation in the meantime.
    AppState.endNavigationRefresh();
    Test.assertEqual(AppState.navigationPending, true);
    AppState.completeNavigation({ "currentIndex" => 2, "queueLength" => 3 });
    Test.assertEqual(AppState.navigationPending, false);
    Test.assertEqual(AppState.currentIndex(), 2);
    AppState.state = null;
    return true;
}

(:test)
function testReconnectForcesRedrawWithoutSequenceChange(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(PollLogic.shouldNotify(false, false), true);
    Test.assertEqual(PollLogic.shouldNotify(false, true), false);
    Test.assertEqual(PollLogic.shouldNotify(true, true), true);
    return true;
}
