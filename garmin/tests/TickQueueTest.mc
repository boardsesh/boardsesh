using Toybox.Test;
using Toybox.Lang;
using Toybox.Application;

(:test)
function testQueueLegacyQuarantineSurvivesVerifiedPairingAndRefresh(logger as Test.Logger) as Lang.Boolean {
    var first = installAuthFixture("owner-a", 70);
    Application.Storage.setValue(TickQueue.KEY, [{ "uuid" => "legacy" }]);
    Test.assertEqual(TickQueue.all().size(), 0);
    Test.assertEqual(TickQueue.enqueue({ "uuid" => "new" }, first), true);
    Test.assertEqual(TickQueue.loadEnvelope()["unowned"].size(), 1);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "new");
    var second = installAuthFixture("owner-b", 80);
    Test.assertEqual(TickQueue.all().size(), 0);
    Test.assertEqual(TickQueue.enqueue({ "uuid" => "other" }, second), true);
    var again = installAuthFixture("owner-a", 90);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "new");
    Test.assertEqual(TickQueue.acknowledge(first, "new"), false);
    Test.assertEqual(TickQueue.acknowledge(again, "new"), true);
    Test.assertEqual(TickQueue.loadEnvelope()["unowned"][0]["uuid"], "legacy");
    return true;
}

(:test)
function testQueueCapacityRefusesWithoutOldestEviction(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 100);
    Application.Storage.setValue(TickQueue.KEY, OwnedTickOutbox.load(null));
    for (var index = 0; index < BuildConfig.TICK_QUEUE_MAX; index += 1) {
        Test.assertEqual(TickQueue.enqueue({ "uuid" => "tick-" + index.toString() }, context), true);
    }
    Test.assertEqual(TickQueue.enqueue({ "uuid" => "overflow" }, context), false);
    Test.assertEqual(TickQueue.size(), BuildConfig.TICK_QUEUE_MAX);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "tick-0");
    return true;
}

(:test)
function testQueueCorruptStorageRefusesWithoutReplacement(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 110);
    Application.Storage.setValue(TickQueue.KEY, { "version" => 99 });
    Test.assertEqual(TickQueue.enqueue({ "uuid" => "tick" }, context), false);
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Dictionary)["version"], 99);
    return true;
}

(:debug)
function savedReply(uuid) {
    return { "data" => { "saveTick" => { "uuid" => uuid } } };
}

(:test)
function testQueueAcceptsOnlyExactTypedUuidAcknowledgement(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(TickQueue.exactAck(200, savedReply("tick"), "tick"), true);
    Test.assertEqual(TickQueue.exactAck(200, savedReply("other"), "tick"), false);
    Test.assertEqual(TickQueue.exactAck(200, savedReply(3), "tick"), false);
    Test.assertEqual(TickQueue.exactAck(200, { "uuid" => "tick" }, "tick"), false);
    Test.assertEqual(TickQueue.exactAck(200, null, "tick"), false);
    Test.assertEqual(TickQueue.exactAck(400, savedReply("tick"), "tick"), false);
    Test.assertEqual(TickQueue.exactAck(200, { "errors" => [], "data" => { "saveTick" => { "uuid" => "tick" } } }, "tick"), false);
    // A status alone is never a verdict on the tick, not even 400.
    var codes = [-104, -400, -2, 200, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503];
    for (var index = 0; index < codes.size(); index += 1) {
        Test.assertEqual(TickQueue.classifyFlushResult(codes[index], null, "tick"), :retry);
    }
    Test.assertEqual(TickQueue.classifyFlushResult(400, nullStateFieldReply("boardType", "String!"), "tick"), :rejected);
    return true;
}

// yoga's HTTP 400 when a variable field is null; see the native contract replay.
(:debug)
function nullStateFieldReply(field, type) {
    return { "errors" => [{ "message" => "Variable \"$input\" got invalid value null at \"input." + field +
        "\"; Expected non-nullable type \"" + type + "\" not to be null." }] };
}

(:test)
function testQueueStaleLeaseCannotReleaseAnotherOwnersRequest(logger as Test.Logger) as Lang.Boolean {
    var first = installAuthFixture("owner-a", 120);
    var oldLease = TickQueue.acquire(first, "same-uuid");
    Test.assertEqual(TickQueue.acquire(first, "same-uuid") == null, true);
    var second = installAuthFixture("owner-b", 130);
    var newLease = TickQueue.acquire(second, "same-uuid");
    Test.assertEqual(TickQueue.release(oldLease), true);
    Test.assertEqual(TickQueue.release(oldLease), false);
    Test.assertEqual(TickQueue.acquire(second, "same-uuid") == null, true);
    Test.assertEqual(TickQueue.release(newLease), true);
    return true;
}

(:debug)
class FlushCompletionObserver {
    var calls = 0;
    function initialize() {}
    function done() as Void { calls += 1; }
}

(:test)
function testFlusherNullStateFieldDeadLettersFrontAndSendsNext(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 270);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "front" }, context);
    TickQueue.enqueue({ "uuid" => "next" }, context);
    var client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    var flusher = new TickFlusher(client);
    flusher.start(observer.method(:done));
    Test.assertEqual(client.sent.size(), 1);
    client.sent[0]["callback"].invoke(400, nullStateFieldReply("angle", "Int!"));
    Test.assertEqual(TickQueue.size(), 1);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "next");
    Test.assertEqual(rejectedEntries()[0]["reason"], "NULL_STATE_FIELD");
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(observer.calls, 0);
    return true;
}

(:test)
function testLateLoggerSuccessRetainsBothOwnersTicksAndReleasesOnlyOwnLease(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 280);
    Application.Storage.setValue(TickQueue.KEY, OwnedTickOutbox.load(null));
    var client = new CapturedBsClient();
    Services.client = client;
    var first = new TickLogger({ "uuid" => "same" });
    Test.assertEqual(first.submit(), true);
    var secondContext = installAuthFixture("owner-b", 290);
    var second = new TickLogger({ "uuid" => "same" });
    Test.assertEqual(second.submit(), true);
    client.sent[0]["callback"].invoke(200, { "data" => { "saveTick" => { "uuid" => "same" } } });
    var envelope = TickQueue.loadEnvelope();
    Test.assertEqual(OwnedTickOutbox.forOwner(envelope, "owner-a").size(), 1);
    Test.assertEqual(OwnedTickOutbox.forOwner(envelope, "owner-b").size(), 1);
    Test.assertEqual(TickQueue.acquire(secondContext, "same") == null, true);
    client.sent[1]["callback"].invoke(200, { "data" => { "saveTick" => { "uuid" => "same" } } });
    envelope = TickQueue.loadEnvelope();
    Test.assertEqual(OwnedTickOutbox.forOwner(envelope, "owner-a").size(), 1);
    Test.assertEqual(OwnedTickOutbox.forOwner(envelope, "owner-b").size(), 0);
    return true;
}

(:debug)
class ExitScopeObserver extends ExitConfirmDelegate {
    var exits = 0;
    function initialize() { ExitConfirmDelegate.initialize(); }
    function exitProcess() as Void { exits += 1; }
}

(:test)
function testStaleFlushCompletionNeverExitsNewLogin(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 370);
    var delegate = new ExitScopeObserver();
    installAuthFixture("owner-b", 380);
    delegate.onFlushed();
    Test.assertEqual(delegate.exits, 0);
    return true;
}
