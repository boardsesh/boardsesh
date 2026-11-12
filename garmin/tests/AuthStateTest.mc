using Toybox.Test;
using Toybox.Lang;

(:debug)
function authResponse(owner) {
    return { "userId" => owner, "jwt" => "access", "refreshToken" => "refresh", "expiresAt" => "expiry" };
}

(:test)
function testAuthBootstrapBindsOnlyVerifiedCredentialsInNewScope(logger as Test.Logger) as Lang.Boolean {
    var old = AuthState.bootstrap("old-access", "old-refresh", "old-expiry");
    Test.assertEqual(old["owner"] == null, true);
    var pending = AuthState.beginRotation(old);
    var bound = AuthState.accept(pending, authResponse("owner-a"), false);
    Test.assertEqual(bound["scope"], 1);
    Test.assertEqual(bound["owner"], "owner-a");
    Test.assertEqual(old["owner"] == null, true);
    Test.assertEqual(AuthState.sameScope(old, bound), false);
    return true;
}

(:test)
function testAuthKnownOwnerRefreshPreservesScopeAndRejectsMismatch(logger as Test.Logger) as Lang.Boolean {
    var active = AuthState.accept(AuthState.empty(4, 7), authResponse("owner-a"), true);
    var pending = AuthState.beginRotation(active);
    Test.assertEqual(AuthState.accept(pending, authResponse("owner-b"), false) == null, true);
    var refreshed = AuthState.accept(pending, authResponse("owner-a"), false);
    Test.assertEqual(refreshed["scope"], active["scope"]);
    Test.assertEqual(AuthState.sameScope(active, refreshed), true);
    Test.assertEqual(AuthState.sameRevision(active, refreshed), false);
    Test.assertEqual(AuthState.beginRotation(pending) == null, true);
    return true;
}

(:test)
function testAuthTombstoneNeverReusesLoginScope(logger as Test.Logger) as Lang.Boolean {
    var first = AuthState.accept(AuthState.empty(0, 0), authResponse("owner-a"), true);
    var cleared = AuthState.clear(first);
    var second = AuthState.accept(cleared, authResponse("owner-a"), true);
    Test.assertEqual(second["scope"] > first["scope"], true);
    Test.assertEqual(AuthState.sameScope(first, second), false);
    Test.assertEqual(AuthState.clear(AuthState.empty(AuthState.MAX_COUNTER, 0)) == null, true);
    Test.assertEqual(AuthState.accept(AuthState.empty(0, AuthState.MAX_COUNTER), authResponse("owner-a"), true) == null, true);
    return true;
}

(:test)
function testAuthMalformedEnvelopeAndResponseRefuse(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(AuthState.valid({ "version" => 99 }), false);
    Test.assertEqual(AuthState.accept(AuthState.empty(0, 0), { "jwt" => "only-access" }, true) == null, true);
    Test.assertEqual(AuthState.accept(AuthState.empty(0, 0), authResponse("owner-a"), false) == null, true);
    Test.assertEqual(AuthState.valid(AuthState.empty(-1, 0)), false);
    return true;
}
