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
