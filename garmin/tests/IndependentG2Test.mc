using Toybox.Test;
using Toybox.Lang;
using Toybox.Application;

(:debug)
class ReviewPollController extends PollController {
    var admitted = 0;
    function initialize() { PollController.initialize(method(:notify)); }
    function notify() as Void {}
    function onStateForGeneration(generation as Lang.Number, code as Lang.Number, payload) as Void { admitted += 1; }
}

(:debug)
class ReviewActivity extends ActivityController {
    var efforts = 0;
    function initialize() { ActivityController.initialize(); }
    function recordAttempt(status as Lang.String, gradeLabel as Lang.String or Null,
            angle as Lang.Object or Null, attemptNum as Lang.Number) as Void { efforts += 1; }
}

(:test)
function testReviewFlusherExactCurrentAckDrainsBothTicks(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 1000);
    Application.Storage.setValue(TickQueue.KEY, OwnedTickOutbox.load(null));
    Test.assert(TickQueue.enqueue({ "uuid" => "front" }, context));
    Test.assert(TickQueue.enqueue({ "uuid" => "next" }, context));
    var client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    Test.assertEqual(client.sent.size(), 1);
    client.sent[0]["callback"].invoke(200, { "data" => { "saveTick" => { "uuid" => "front" } } });
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(TickQueue.size(), 1);
    client.sent[1]["callback"].invoke(200, { "data" => { "saveTick" => { "uuid" => "next" } } });
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(observer.calls, 1);
    return true;
}

(:test)
function testReviewFlusherRetainsEveryNonExactResult(logger as Test.Logger) as Lang.Boolean {
    var replies = [null, { "data" => { "saveTick" => { "uuid" => "wrong" } } },
        { "errors" => ["refused"], "data" => { "saveTick" => { "uuid" => "front" } } },
        { "data" => { "saveTick" => { "uuid" => "front" } } }];
    for (var index = 0; index < replies.size(); index += 1) {
        var context = installAuthFixture("owner-a", 1100 + index * 10);
        Application.Storage.setValue(TickQueue.KEY, OwnedTickOutbox.load(null));
        TickQueue.enqueue({ "uuid" => "front" }, context);
        var client = new CapturedBsClient();
        var observer = new FlushCompletionObserver();
        new TickFlusher(client).start(observer.method(:done));
        client.sent[0]["callback"].invoke(index == 3 ? 422 : 200, replies[index]);
        Test.assertEqual(TickQueue.size(), 1);
        Test.assertEqual(client.sent.size(), 1);
        Test.assertEqual(observer.calls, 1);
    }
    return true;
}

(:test)
function testReviewPollUsesResponseOriginAndRejectsOldLogin(logger as Test.Logger) as Lang.Boolean {
    var first = installAuthFixture("owner-a", 1200);
    var controller = new ReviewPollController();
    var response = new PollStateResponse(controller, 7);
    var second = installAuthFixture("owner-b", 1210);
    AppState.authContext = second;
    response.onResult(200, {}, first);
    Test.assertEqual(controller.admitted, 0);
    Test.assertEqual(AppState.authContext["scope"], second["scope"]);
    response.onResult(200, {}, second);
    Test.assertEqual(controller.admitted, 1);
    Test.assertEqual(AppState.authContext["scope"], second["scope"]);
    return true;
}

(:test)
function testReviewClimbDurabilityPrecedesFitAndSessionOptimism(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 1300);
    AppState.attachSession("session", "fixture");
    AppState.authContext = context;
    AppState.state = { "boardType" => "kilter", "angle" => 40,
        "layoutId" => 1, "sizeId" => 1, "setIds" => [1],
        "climb" => { "climbUuid" => "climb", "difficulty" => "V1", "mirrored" => false, "isBenchmark" => false } };
    SessionLog.reset();
    Application.Storage.setValue(TickQueue.KEY, OwnedTickOutbox.load(null));
    var client = new CapturedBsClient();
    var activity = new ReviewActivity();
    Services.client = client;
    Services.activity = activity;
    var store = new RefusingWatchStore();
    store.refuseKey = TickQueue.KEY;
    WatchStore.backend = store;
    new ClimbDelegate().onBack();
    Test.assertEqual(activity.efforts, 0);
    Test.assertEqual(SessionLog.attempts(), 0);
    Test.assertEqual(client.sent.size(), 0);
    WatchStore.backend = new WatchObjectStore();
    new ClimbDelegate().onBack();
    Test.assertEqual(activity.efforts, 1);
    Test.assertEqual(SessionLog.attempts(), 1);
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(TickQueue.size(), 1);
    return true;
}

(:test)
function testReviewStaleCredentialCasCannotPublishOverNewLogin(logger as Test.Logger) as Lang.Boolean {
    var first = installAuthFixture("owner-a", 1400);
    var pending = TokenStore.beginRotation(first);
    var second = installAuthFixture("owner-b", 1410);
    Test.assertEqual(TokenStore.acceptRotation(pending, authResponse("owner-a")), false);
    Test.assertEqual(TokenStore.acceptPair(first, authResponse("owner-a")), false);
    Test.assertEqual(TokenStore.snapshot()["owner"], "owner-b");
    Test.assertEqual(TokenStore.snapshot()["scope"], second["scope"]);
    return true;
}

(:test)
function testReviewActualPairingReplyAndReadSuccessCannotCrossLogins(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 1500);
    Application.Storage.setValue(TickQueue.KEY, [{ "uuid" => "legacy-pair" }]);
    var client = new CapturedBsClient();
    Services.client = client;
    var view = new PairingView();
    for (var index = 0; index < 8; index += 1) { view.confirm(); }
    Test.assertEqual(client.sent.size(), 1);
    var next = installAuthFixture("owner-b", 1510);
    client.sent[0]["callback"].invoke(200, authResponse("owner-a"));
    Test.assertEqual(TokenStore.snapshot()["owner"], "owner-b");
    Test.assertEqual(TokenStore.snapshot()["scope"], next["scope"]);
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Array)[0]["uuid"], "legacy-pair");
    var observer = new RequestResultObserver();
    var request = new BsRequest(client, "https://example.invalid", {}, 0, true, null, observer.method(:onResult));
    request.fire();
    installAuthFixture("owner-a", 1520);
    request.onResponse(200, { "private" => true });
    Test.assertEqual(observer.code, BsResponse.STALE);
    Test.assertEqual(observer.result == null, true);
    return true;
}
