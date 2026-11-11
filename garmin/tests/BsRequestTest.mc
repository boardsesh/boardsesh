using Toybox.Test;
using Toybox.Lang;
using Toybox.Application;

(:debug)
class RequestResultObserver {
    var result = null;
    var code = null;
    var origin = null;
    var calls = 0;
    function initialize() {}
    function onResult(status as Lang.Number, payload, context) as Void {
        code = status; result = payload; origin = context; calls += 1;
    }
}

(:debug)
class CapturedBsClient extends BsClient {
    var sent as Lang.Array = [];
    var lost = 0;
    function initialize() { BsClient.initialize("https://example.invalid", method(:lostAuth)); }
    function lostAuth() as Void { lost += 1; }
    function sendRaw(url as Lang.String, params, httpMethod as Lang.Number, token, callback) as Void {
        sent.add({ "token" => token, "callback" => callback, "params" => params });
    }
}

(:debug)
function installAuthFixture(owner, scope) {
    var active = AuthState.accept(AuthState.empty(scope, 0), authResponse(owner), true);
    Application.Storage.setValue(TokenStore.KEY, active);
    TokenStore._blocked = false;
    return active;
}

(:test)
function testGraphqlResponseRejectsMalformedNestedData(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 10);
    var observer = new RequestResultObserver();
    var client = new CapturedBsClient();
    var malformed = ["not an object", [1, 2], { "saveTick" => { "uuid" => "tick" } }];
    for (var index = 0; index < malformed.size(); index += 1) {
        var request = new BsRequest(client, "https://example.invalid", {}, 0, false,
            "saveTick", observer.method(:onResult));
        request.onResponse(200, { "data" => malformed[index] });
        if (index < 2) { Test.assertEqual(observer.result == null, true); }
        else { Test.assertEqual(observer.result["uuid"], "tick"); }
    }
    return true;
}

(:test)
function testOldUnauthorizedCannotRetryWithNewOwnersJwt(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 20);
    var observer = new RequestResultObserver();
    var client = new CapturedBsClient();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.fire();
    installAuthFixture("owner-b", 30);
    request.onResponse(401, null);
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(observer.code, BsResponse.STALE);
    Test.assertEqual(observer.calls, 1);
    Test.assertEqual(TokenStore.snapshot()["owner"], "owner-b");
    request.onResponse(200, { "unexpected" => true });
    Test.assertEqual(observer.calls, 1);
    return true;
}

(:test)
function testLateRefreshCannotClobberNewLoginOrRouteIt(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 40);
    var observer = new RequestResultObserver();
    var client = new CapturedBsClient();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.onResponse(401, null);
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(TokenStore.snapshot()["status"], "rotating");
    installAuthFixture("owner-b", 50);
    client.sent[0]["callback"].invoke(200, authResponse("owner-a"));
    Test.assertEqual(TokenStore.snapshot()["owner"], "owner-b");
    Test.assertEqual(client.lost, 0);
    Test.assertEqual(observer.code, BsResponse.STALE);
    return true;
}

(:test)
function testRefreshRetriesOnlyWithinCapturedLoginScope(logger as Test.Logger) as Lang.Boolean {
    var initial = installAuthFixture("owner-a", 60);
    var observer = new RequestResultObserver();
    var client = new CapturedBsClient();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.onResponse(401, null);
    var response = authResponse("owner-a");
    response["jwt"] = "rotated-access";
    client.sent[0]["callback"].invoke(200, response);
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(client.sent[1]["token"], "rotated-access");
    Test.assertEqual(TokenStore.snapshot()["scope"], initial["scope"]);
    client.sent[1]["callback"].invoke(200, { "kept" => true });
    Test.assertEqual(observer.result["kept"], true);
    Test.assertEqual(observer.calls, 1);
    return true;
}

(:test)
function testOldRefreshFailureCannotClearNewOwnersRefreshFlight(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 240);
    var client = new CapturedBsClient();
    var first = new RequestResultObserver();
    var oldRequest = new BsRequest(client, "https://example.invalid", {}, 0, true, null, first.method(:onResult));
    oldRequest.onResponse(401, null);
    installAuthFixture("owner-b", 250);
    var second = new RequestResultObserver();
    var newRequest = new BsRequest(client, "https://example.invalid", {}, 0, true, null, second.method(:onResult));
    newRequest.onResponse(401, null);
    Test.assertEqual(client.sent.size(), 2);
    client.sent[0]["callback"].invoke(401, null);
    Test.assertEqual(client.lost, 0);
    Test.assertEqual(first.code, BsResponse.STALE);
    client.sent[1]["callback"].invoke(200, authResponse("owner-b"));
    Test.assertEqual(client.sent.size(), 3);
    client.sent[2]["callback"].invoke(200, { "done" => true });
    Test.assertEqual(second.result["done"], true);
    Test.assertEqual(TokenStore.snapshot()["owner"], "owner-b");
    return true;
}

(:test)
function testAmbiguousRefreshNeverRetriesConsumedSecretAndRetainsLegacyTicks(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 260);
    Application.Storage.setValue(TickQueue.KEY, [{ "uuid" => "unowned" }]);
    var client = new CapturedBsClient();
    var observer = new RequestResultObserver();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.onResponse(401, null);
    client.sent[0]["callback"].invoke(503, null);
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(client.lost, 0);
    Test.assertEqual(TokenStore.hasTokens(), true);
    Test.assertEqual(TokenStore.refreshToken() == null, true);
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Array)[0]["uuid"], "unowned");
    // Existing access/offline use continues; actual JWT rejection asks pairing
    // without ever retrying the ambiguously consumed refresh secret.
    var next = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    next.fire();
    Test.assertEqual(client.sent.size(), 2);
    next.onResponse(401, null);
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(client.lost, 1);
    Test.assertEqual(TokenStore.hasTokens(), false);
    return true;
}

(:test)
function testProvenPreSendAndRollbackFailuresRecoverWithoutPairing(logger as Test.Logger) as Lang.Boolean {
    var responses = [
        { "code" => -104, "body" => null },
        { "code" => -101, "body" => null },
        { "code" => 503, "body" => { "error" => "Service temporarily overloaded" } },
        { "code" => 503, "body" => { "error" => "Authentication is temporarily unavailable" } },
        { "code" => 429, "body" => { "error" => "Rate limit exceeded. Try again in 10 seconds." } }
    ];
    for (var index = 0; index < responses.size(); index += 1) {
        var initial = installAuthFixture("owner-a", 300 + index * 10);
        var client = new CapturedBsClient();
        var observer = new RequestResultObserver();
        var first = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
        first.onResponse(401, null);
        client.sent[0]["callback"].invoke(responses[index]["code"], responses[index]["body"]);
        Test.assertEqual(client.lost, 0);
        Test.assertEqual(AuthState.statusIs(TokenStore.snapshot(), "active"), true);
        Test.assertEqual(TokenStore.snapshot()["scope"], initial["scope"]);
        Test.assertEqual(TokenStore.refreshToken(), "refresh");
        var retry = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
        retry.onResponse(401, null);
        Test.assertEqual(client.sent.size(), 2);
        client.sent[1]["callback"].invoke(200, authResponse("owner-a"));
        Test.assertEqual(client.sent.size(), 3);
        client.sent[2]["callback"].invoke(200, { "recovered" => true });
        Test.assertEqual(observer.result["recovered"], true);
        Test.assertEqual(client.lost, 0);
    }
    return true;
}

(:test)
function testAmbiguousTimeoutDoesNotPermitRefreshReuseButKeepsOwnedOfflineLogging(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 360);
    Application.Storage.setValue(TickQueue.KEY, OwnedTickOutbox.load(null));
    var client = new CapturedBsClient();
    var observer = new RequestResultObserver();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.onResponse(401, null);
    client.sent[0]["callback"].invoke(-300, null);
    var pending = TokenStore.snapshot();
    Test.assertEqual(AuthState.statusIs(pending, "rotating"), true);
    Test.assertEqual(TokenStore.refreshToken() == null, true);
    Test.assertEqual(TokenStore.jwt(), "access");
    Test.assertEqual(TickQueue.enqueue({ "uuid" => "offline-after-timeout" }, pending), true);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "offline-after-timeout");
    Test.assertEqual(client.lost, 0);
    return true;
}

(:test)
function testStaleBootstrapRequestCannotAdoptAnotherLoginAsItsRefresh(logger as Test.Logger) as Lang.Boolean {
    Application.Storage.setValue(TokenStore.KEY, AuthState.bootstrap("old-access", "old-refresh", "expiry"));
    TokenStore._blocked = false;
    var client = new CapturedBsClient();
    var observer = new RequestResultObserver();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    var replacement = installAuthFixture("owner-b", 410);
    request.retryWith(replacement);
    Test.assertEqual(client.sent.size(), 0);
    Test.assertEqual(observer.code, BsResponse.STALE);
    return true;
}

(:test)
function testVerifiedBootstrapRefreshCompletesReadWithoutAdoptingLegacyTicks(logger as Test.Logger) as Lang.Boolean {
    Application.Storage.setValue(TokenStore.KEY, AuthState.bootstrap("old-access", "old-refresh", "expiry"));
    Application.Storage.setValue(TickQueue.KEY, [{ "uuid" => "legacy-bootstrap" }]);
    TokenStore._blocked = false;
    var client = new CapturedBsClient();
    var observer = new RequestResultObserver();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.fire();
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(client.sent[0]["params"]["refreshToken"], "old-refresh");
    client.sent[0]["callback"].invoke(200, authResponse("owner-a"));
    Test.assertEqual(client.sent.size(), 2);
    client.sent[1]["callback"].invoke(200, { "read" => true });
    Test.assertEqual(observer.result["read"], true);
    Test.assertEqual(observer.origin["scope"], 1);
    Test.assertEqual(TokenStore.snapshot()["owner"], "owner-a");
    Test.assertEqual(TickQueue.all().size(), 0);
    Test.assertEqual(TickQueue.loadEnvelope()["unowned"][0]["uuid"], "legacy-bootstrap");
    return true;
}
