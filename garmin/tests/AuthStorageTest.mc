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

(:debug)
class LoadingStorageRetryObserver extends LoadingView {
    var retries = 0;
    var lastCode = 0;
    function initialize() { LoadingView.initialize(); }
    function onSessions(code as Lang.Number, payload, origin) as Void {
        lastCode = code;
        LoadingView.onSessions(code, payload, origin);
    }
    function showNoSession() as Void { retries += 1; }
}

(:debug)
function verifyLoadingRecoversAfterPreSendStorageRefusal(bootstrap as Lang.Boolean) as Void {
    if (bootstrap) {
        Application.Storage.setValue(TokenStore.KEY, AuthState.bootstrap("old-access", "old-refresh", "expiry"));
        TokenStore._blocked = false;
    } else {
        installAuthFixture("owner-a", 1600);
    }
    Application.Storage.setValue(TickQueue.KEY, [{ "uuid" => "retained-during-storage-refusal" }]);
    var initial = TokenStore.snapshot();
    var client = new CapturedBsClient();
    Services.client = client;
    var fixture = new RefusingWatchStore();
    fixture.refuseKey = TokenStore.KEY;
    WatchStore.backend = fixture;
    var view = new LoadingStorageRetryObserver();
    view.onShow();
    if (!bootstrap) { client.sent[0]["callback"].invoke(401, null); }
    Test.assertEqual(view.lastCode, 503);
    Test.assertEqual(view.retries, 1);
    Test.assertEqual(client.lost, 0);
    Test.assertEqual(client.sent.size(), bootstrap ? 0 : 1);
    Test.assertEqual(AuthState.sameRevision(initial, TokenStore.snapshot()), true);
    Test.assertEqual(TokenStore.refreshToken(), bootstrap ? "old-refresh" : "refresh");
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Array)[0]["uuid"], "retained-during-storage-refusal");

    // An explicit retry after storage recovers really refreshes and completes
    // the loading read; it cannot pass by permanently refusing every attempt.
    WatchStore.backend = new WatchObjectStore();
    view.onShow();
    var refreshIndex = bootstrap ? 0 : 2;
    if (!bootstrap) { client.sent[1]["callback"].invoke(401, null); }
    Test.assertEqual(client.sent.size(), refreshIndex + 1);
    var response = authResponse("owner-a");
    response["jwt"] = "rotated-after-storage-recovery";
    client.sent[refreshIndex]["callback"].invoke(200, response);
    Test.assertEqual(client.sent.size(), refreshIndex + 2);
    client.sent[refreshIndex + 1]["callback"].invoke(200, { "data" => { "mySessions" => [] } });
    Test.assertEqual(view.lastCode, 200);
    Test.assertEqual(view.retries, 2);
    Test.assertEqual(client.lost, 0);
    Test.assertEqual(TokenStore.jwt(), "rotated-after-storage-recovery");
    Test.assertEqual(AppState.authContext["scope"], TokenStore.snapshot()["scope"]);
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Array)[0]["uuid"], "retained-during-storage-refusal");
}

(:test)
function testLoadingActiveCredentialsStorageRefusalIsRetryableAndRecovers(logger as Test.Logger) as Lang.Boolean {
    verifyLoadingRecoversAfterPreSendStorageRefusal(false);
    return true;
}

(:test)
function testLoadingBootstrapStorageRefusalIsRetryableAndRecovers(logger as Test.Logger) as Lang.Boolean {
    verifyLoadingRecoversAfterPreSendStorageRefusal(true);
    return true;
}

(:debug)
class PersistingThenRefusingAuthStore extends WatchObjectStore {
    function initialize() { WatchObjectStore.initialize(); }
    function write(key as Lang.String, contents) as Void {
        WatchObjectStore.write(key, contents);
        if (key.equals(TokenStore.KEY)) { throw new FixtureWriteFailure(); }
    }
}

(:test)
function testLoadingBootstrapAmbiguousPreSendPersistenceNeverHangsAfterRetry(logger as Test.Logger) as Lang.Boolean {
    Application.Storage.setValue(TokenStore.KEY, AuthState.bootstrap("old-access", "old-refresh", "expiry"));
    Application.Storage.setValue(TickQueue.KEY, [{ "uuid" => "retained-after-ambiguous-storage" }]);
    TokenStore._blocked = false;
    var client = new CapturedBsClient();
    Services.client = client;
    Services.activity = null;
    WatchStore.backend = new PersistingThenRefusingAuthStore();
    var view = new LoadingStorageRetryObserver();
    view.onShow();
    var initialCode = view.lastCode;
    // Storage is usable again, but the persisted rotating marker must neither
    // resubmit the old refresh secret nor leave a 401 on Loading without routing.
    WatchStore.backend = new WatchObjectStore();
    view.onShow();
    Test.assertEqual(initialCode, 503);
    Test.assertEqual(client.sent.size(), 0);
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Array)[0]["uuid"], "retained-after-ambiguous-storage");
    Test.assertEqual(view.lastCode == 401 && client.lost == 0, false);
    Test.assertEqual(client.lost, 1);
    Test.assertEqual(AuthState.statusIs(TokenStore.snapshot(), "empty"), true);
    Test.assertEqual(TokenStore.refreshToken() == null, true);
    return true;
}

(:test)
function testConcurrentBootstrapReadJoinsLiveRotationWithoutReusingRefresh(logger as Test.Logger) as Lang.Boolean {
    Application.Storage.setValue(TokenStore.KEY, AuthState.bootstrap("old-access", "old-refresh", "expiry"));
    TokenStore._blocked = false;
    var client = new CapturedBsClient();
    var first = new RequestResultObserver();
    var second = new RequestResultObserver();
    var firstRequest = new BsRequest(client, "https://example.invalid", {}, 0, true, null, first.method(:onResult));
    firstRequest.fire();
    var secondRequest = new BsRequest(client, "https://example.invalid", {}, 0, true, null, second.method(:onResult));
    secondRequest.fire();
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(client.lost, 0);
    client.sent[0]["callback"].invoke(200, authResponse("owner-a"));
    Test.assertEqual(client.sent.size(), 3);
    client.sent[1]["callback"].invoke(200, { "read" => true });
    client.sent[2]["callback"].invoke(200, { "read" => true });
    Test.assertEqual(first.result["read"], true);
    Test.assertEqual(second.result["read"], true);
    Test.assertEqual(client.lost, 0);
    Test.assertEqual(first.origin["scope"], second.origin["scope"]);
    return true;
}
