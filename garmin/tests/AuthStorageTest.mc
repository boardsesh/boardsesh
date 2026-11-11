using Toybox.Test;
using Toybox.Lang;
using Toybox.Application;

(:debug)
class FixtureWriteFailure extends Lang.Exception {
    function initialize() { Exception.initialize(); }
}

(:debug)
class RefusingWatchStore extends WatchObjectStore {
    var refuseKey = null;
    var writes = 0;
    function initialize() { WatchObjectStore.initialize(); }
    function write(key as Lang.String, contents) as Void {
        writes += 1;
        if (refuseKey != null && key.equals(refuseKey)) { throw new FixtureWriteFailure(); }
        WatchObjectStore.write(key, contents);
    }
}

(:test)
function testAuthV2TombstoneNeverFallsBackToOldCredentialKeys(logger as Test.Logger) as Lang.Boolean {
    Application.Storage.setValue(TokenStore.KEY_JWT, "legacy-access");
    Application.Storage.setValue(TokenStore.KEY_REFRESH, "legacy-refresh");
    Application.Storage.setValue(TokenStore.KEY_EXP, "legacy-expiry");
    Application.Storage.setValue(TokenStore.KEY, AuthState.empty(200, 300));
    TokenStore._blocked = false;
    Test.assertEqual(TokenStore.hasTokens(), false);
    Test.assertEqual(TokenStore.jwt() == null, true);
    Test.assertEqual(TokenStore.snapshot()["scope"], 200);
    Application.Storage.setValue(TokenStore.KEY, { "version" => 99 });
    Test.assertEqual(TokenStore.snapshot() == null, true);
    Test.assertEqual(TokenStore.hasTokens(), false);
    Test.assertEqual((Application.Storage.getValue(TokenStore.KEY) as Lang.Dictionary)["version"], 99);
    return true;
}

(:test)
function testAuthFailedRotationPersistenceNeverPublishesOrReusesConsumedToken(logger as Test.Logger) as Lang.Boolean {
    var active = installAuthFixture("owner-a", 210);
    var pending = TokenStore.beginRotation(active);
    var fixture = new RefusingWatchStore();
    fixture.refuseKey = TokenStore.KEY;
    WatchStore.backend = fixture;
    var response = authResponse("owner-a");
    response["jwt"] = "unpersisted-access";
    Test.assertEqual(TokenStore.acceptRotation(pending, response), false);
    Test.assertEqual(TokenStore.jwt(), "access");
    Test.assertEqual(TokenStore.refreshToken() == null, true);
    Test.assertEqual(TokenStore.beginRotation(TokenStore.snapshot()) == null, true);
    Test.assertEqual((Application.Storage.getValue(TokenStore.KEY) as Lang.Dictionary)["status"], "rotating");
    Test.assertEqual((Application.Storage.getValue(TokenStore.KEY) as Lang.Dictionary)["jwt"], "access");
    WatchStore.backend = new WatchObjectStore();
    return true;
}

(:test)
function testQueueStorageFailureRefusesBeforeFirstHttpRequest(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 220);
    Application.Storage.setValue(TickQueue.KEY, [{ "uuid" => "legacy" }]);
    var fixture = new RefusingWatchStore();
    fixture.refuseKey = TickQueue.KEY;
    WatchStore.backend = fixture;
    var client = new CapturedBsClient();
    Services.client = client;
    Test.assertEqual(new TickLogger({ "uuid" => "must-not-send" }).submit(), false);
    Test.assertEqual(client.sent.size(), 0);
    Test.assertEqual(Application.Storage.getValue(TickQueue.KEY).size(), 1);
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Array)[0]["uuid"], "legacy");
    WatchStore.backend = new WatchObjectStore();
    return true;
}

(:test)
function testPairingStorageFailureCannotExposeNewOwnerOrTokens(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 230);
    var attempt = TokenStore.beginPairing();
    var fixture = new RefusingWatchStore();
    fixture.refuseKey = TokenStore.KEY;
    WatchStore.backend = fixture;
    Test.assertEqual(TokenStore.acceptPair(attempt, authResponse("owner-b")), false);
    Test.assertEqual(TokenStore.snapshot()["owner"] == null, true);
    Test.assertEqual(TokenStore.jwt() == null, true);
    WatchStore.backend = new WatchObjectStore();
    return true;
}

(:test)
function testKnownSuccessfulRotationStorageFailureNeverPublishesOrRetries(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 390);
    var client = new CapturedBsClient();
    var observer = new RequestResultObserver();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.onResponse(401, null);
    var fixture = new RefusingWatchStore();
    fixture.refuseKey = TokenStore.KEY;
    WatchStore.backend = fixture;
    var response = authResponse("owner-a");
    response["jwt"] = "must-not-publish";
    client.sent[0]["callback"].invoke(200, response);
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(client.lost, 1);
    Test.assertEqual(TokenStore.jwt() == null, true);
    Test.assertEqual((Application.Storage.getValue(TokenStore.KEY) as Lang.Dictionary)["jwt"], "access");
    Test.assertEqual((Application.Storage.getValue(TokenStore.KEY) as Lang.Dictionary)["status"], "rotating");
    WatchStore.backend = new WatchObjectStore();
    TokenStore._blocked = false;
    Test.assertEqual(TokenStore.refreshToken() == null, true);
    return true;
}
