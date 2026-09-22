using Toybox.Test;
using Toybox.Lang;

(:debug)
class RequestResultObserver {
    var result = null;
    function initialize() {}
    function onResult(code as Lang.Number, payload) as Void {
        result = payload;
    }
}

(:test)
function testGraphqlResponseRejectsMalformedNestedData(logger as Test.Logger) as Lang.Boolean {
    var observer = new RequestResultObserver();
    var client = new BsClient("https://example.invalid", null);
    var request = new BsRequest(client, "https://example.invalid", {}, 0, false,
        "saveTick", observer.method(:onResult));
    request.onResponse(200, { "data" => "not an object" });
    Test.assertEqual(observer.result == null, true);
    request.onResponse(200, { "data" => [1, 2] });
    Test.assertEqual(observer.result == null, true);
    request.onResponse(200, { "data" => { "saveTick" => { "uuid" => "tick" } } });
    Test.assertEqual(observer.result["uuid"], "tick");
    return true;
}

// Replace only the destructive auth-loss callback. No storage or network I/O.
(:debug)
class RefreshResultClient extends BsClient {
    var lostAuth = false;
    function initialize() {
        BsClient.initialize("https://example.invalid", null);
    }
    function _onRefreshFailed() as Void {
        lostAuth = true;
    }
}

(:test)
function testRefreshRateLimitKeepsAuthentication(logger as Test.Logger) as Lang.Boolean {
    var client = new RefreshResultClient();
    client._onRefreshResponse(429, null);
    Test.assertEqual(client.lostAuth, false);
    client._onRefreshResponse(503, null);
    Test.assertEqual(client.lostAuth, false);
    client._onRefreshResponse(401, null);
    Test.assertEqual(client.lostAuth, true);
    return true;
}
