using Toybox.Test;
using Toybox.Lang;
using Toybox.Application;

// Retry and Delete for the dead-letter store (#7636). Retry moves the
// signed-in owner's refused ticks back to the end of their queue with the
// same UUIDs; Delete drops only that owner's entries. Neither ever touches
// another account's entries or evicts a queued tick.

(:debug)
function refusedFixtureStore() {
    var store = RejectedTicks.empty();
    store = RejectedTicks.add(store, "owner-a", { "uuid" => "a-1" }, "CLIMB_NOT_FOUND", BuildConfig.REJECTED_TICK_MAX);
    store = RejectedTicks.add(store, "owner-b", { "uuid" => "b-1" }, "INVALID_INPUT", BuildConfig.REJECTED_TICK_MAX);
    store = RejectedTicks.add(store, "owner-a", { "uuid" => "a-2" }, "NULL_STATE_FIELD", BuildConfig.REJECTED_TICK_MAX);
    return store;
}

(:test)
function testRequeueMovesOnlyThisOwnersTicksToTheEndWithinCapacity(logger as Test.Logger) as Lang.Boolean {
    var store = refusedFixtureStore();
    var envelope = OwnedTickOutbox.append(OwnedTickOutbox.load(null), "owner-a", { "uuid" => "queued" }, 25);
    var result = RejectedTicks.requeue(envelope, store, "owner-a", 25, 25);
    Test.assertEqual(result["moved"], 2);
    var queue = OwnedTickOutbox.forOwner(result["envelope"], "owner-a");
    Test.assertEqual(queue.size(), 3);
    Test.assertEqual(queue[0]["uuid"], "queued");
    Test.assertEqual(queue[1]["uuid"], "a-1");
    Test.assertEqual(queue[2]["uuid"], "a-2");
    Test.assertEqual(result["store"]["entries"].size(), 1);
    Test.assertEqual(result["store"]["entries"][0]["owner"], "owner-b");
    // Copy-on-write: the inputs are unchanged.
    Test.assertEqual(store["entries"].size(), 3);
    Test.assertEqual(OwnedTickOutbox.forOwner(envelope, "owner-a").size(), 1);

    // Room for one more queued tick: the oldest moves, the other stays refused.
    var tight = RejectedTicks.requeue(envelope, store, "owner-a", 2, 25);
    Test.assertEqual(tight["moved"], 1);
    Test.assertEqual(OwnedTickOutbox.forOwner(tight["envelope"], "owner-a")[1]["uuid"], "a-1");
    Test.assertEqual(RejectedTicks.forOwner(tight["store"], "owner-a").size(), 1);
    Test.assertEqual(RejectedTicks.forOwner(tight["store"], "owner-a")[0]["tick"]["uuid"], "a-2");

    // A full queue, an owner with nothing refused, or invalid input moves nothing.
    Test.assertEqual(RejectedTicks.requeue(envelope, store, "owner-a", 1, 25) == null, true);
    Test.assertEqual(RejectedTicks.requeue(envelope, store, "owner-c", 25, 25) == null, true);
    Test.assertEqual(RejectedTicks.requeue(envelope, { "version" => 9, "entries" => [] }, "owner-a", 25, 25) == null, true);
    Test.assertEqual(RejectedTicks.requeue({ "version" => 9 }, store, "owner-a", 25, 25) == null, true);

    // A crash between the two writes left a-1 in both stores: it leaves the
    // store but is not queued a second time.
    var crashed = OwnedTickOutbox.append(envelope, "owner-a", { "uuid" => "a-1" }, 25);
    var deduplicated = RejectedTicks.requeue(crashed, store, "owner-a", 25, 25);
    queue = OwnedTickOutbox.forOwner(deduplicated["envelope"], "owner-a");
    Test.assertEqual(queue.size(), 3);
    Test.assertEqual(queue[1]["uuid"], "a-1");
    Test.assertEqual(queue[2]["uuid"], "a-2");
    Test.assertEqual(RejectedTicks.countFor(deduplicated["store"], "owner-a"), 0);

    // At most `limit` per call: the oldest moves first.
    var limited = RejectedTicks.requeue(envelope, store, "owner-a", 25, 1);
    Test.assertEqual(limited["moved"], 1);
    Test.assertEqual(RejectedTicks.forOwner(limited["store"], "owner-a")[0]["tick"]["uuid"], "a-2");
    // Another account owns a conflicting UUID: retrying cannot help, it stays.
    var conflict = RejectedTicks.add(RejectedTicks.empty(), "owner-a", { "uuid" => "taken" }, "TICK_UUID_CONFLICT", 25);
    Test.assertEqual(RejectedTicks.requeue(envelope, conflict, "owner-a", 25, 25) == null, true);
    Test.assertEqual(RejectedTicks.requeue(envelope, store, "owner-a", 25, 0) == null, true);

    var cleared = RejectedTicks.withoutOwner(store, "owner-a");
    Test.assertEqual(cleared["entries"].size(), 1);
    Test.assertEqual(cleared["entries"][0]["tick"]["uuid"], "b-1");
    Test.assertEqual(RejectedTicks.withoutOwner({ "version" => 9, "entries" => [] }, "owner-a") == null, true);
    return true;
}

(:test)
function testRetriedRefusalResendsTheSameUuidAndSettlesOnce(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3000);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "refused", "climbUuid" => "spray-climb" }, context);
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    Test.assertEqual(TickQueue.refusedEntries().size(), 1);
    Test.assertEqual(TickQueue.refusedEntries()[0]["reason"], "CLIMB_NOT_FOUND");

    // Logged after the refusal; the retried tick goes behind it.
    TickQueue.enqueue({ "uuid" => "newer" }, context);
    Test.assertEqual(TickQueue.retryRefused(context), 1);
    Test.assertEqual(rejectedEntries().size(), 0);
    Test.assertEqual(TickQueue.all().size(), 2);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "newer");
    Test.assertEqual(TickQueue.all()[1]["uuid"], "refused");

    client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    client.sent[0]["callback"].invoke(200, savedReply("newer"));
    // The stored tick, unchanged: same UUID, so the server cannot save it twice.
    Test.assertEqual(client.sent[1]["params"]["variables"]["input"]["uuid"], "refused");
    Test.assertEqual(client.sent[1]["params"]["variables"]["input"]["climbUuid"], "spray-climb");
    client.sent[1]["callback"].invoke(200, savedReply("refused"));
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries().size(), 0);
    Test.assertEqual(observer.calls, 1);
    return true;
}

(:test)
function testRefusedAgainAfterRetryReturnsToTheListOnce(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3010);
    resetTickStores();
    Application.Storage.setValue(TickQueue.REJECTED_KEY,
        RejectedTicks.add(RejectedTicks.empty(), "owner-a", { "uuid" => "still-gone" }, "CLIMB_NOT_FOUND", 25));
    Test.assertEqual(TickQueue.retryRefused(context), 1);
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries().size(), 1);
    Test.assertEqual(rejectedEntries()[0]["tick"]["uuid"], "still-gone");
    return true;
}

// A failed dead-letter write after the outbox write leaves a copy in both.
// Whatever the server says next, the UUID is the same and nothing doubles.
(:test)
function testRetryWriteFailureLeavesACopyInBothAndNeverASecondEntry(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3020);
    resetTickStores();
    Application.Storage.setValue(TickQueue.REJECTED_KEY,
        RejectedTicks.add(RejectedTicks.empty(), "owner-a", { "uuid" => "both" }, "CLIMB_NOT_FOUND", 25));
    var refusing = new RefusingWatchStore();
    refusing.refuseKey = TickQueue.REJECTED_KEY;
    WatchStore.backend = refusing;
    Test.assertEqual(TickQueue.retryRefused(context), 1);
    WatchStore.backend = new WatchObjectStore();
    Test.assertEqual(TickQueue.all()[0]["uuid"], "both");
    Test.assertEqual(rejectedEntries().size(), 1);

    // Refused again: the existing entry absorbs it, no second entry.
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries().size(), 1);

    // Saved instead: the next retry resends the same UUID, and the server
    // answers the stored tick.
    Test.assertEqual(TickQueue.retryRefused(context), 1);
    client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    Test.assertEqual(client.sent[0]["params"]["variables"]["input"]["uuid"], "both");
    client.sent[0]["callback"].invoke(200, savedReply("both"));
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries().size(), 0);

    // An outbox write failure moves nothing and loses nothing.
    Application.Storage.setValue(TickQueue.REJECTED_KEY,
        RejectedTicks.add(RejectedTicks.empty(), "owner-a", { "uuid" => "unmoved" }, "CLIMB_NOT_FOUND", 25));
    refusing = new RefusingWatchStore();
    refusing.refuseKey = TickQueue.KEY;
    WatchStore.backend = refusing;
    Test.assertEqual(TickQueue.retryRefused(context), 0);
    WatchStore.backend = new WatchObjectStore();
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries()[0]["tick"]["uuid"], "unmoved");
    resetTickStores();
    return true;
}

(:test)
function testDeleteDropsOnlyTheSignedInOwnersRefusedTicks(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3030);
    resetTickStores();
    Application.Storage.setValue(TickQueue.REJECTED_KEY, refusedFixtureStore());
    TickQueue.enqueue({ "uuid" => "queued" }, context);
    Test.assertEqual(TickQueue.clearRefused(context), 2);
    Test.assertEqual(rejectedEntries().size(), 1);
    Test.assertEqual(rejectedEntries()[0]["owner"], "owner-b");
    // The outbox is untouched.
    Test.assertEqual(TickQueue.all().size(), 1);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "queued");
    Test.assertEqual(TickQueue.clearRefused(context), 0);

    // Another account cannot retry or delete owner-a's entries, and an old
    // login's context does nothing once someone else signed in.
    Application.Storage.setValue(TickQueue.REJECTED_KEY, refusedFixtureStore());
    var other = installAuthFixture("owner-b", 3040);
    Test.assertEqual(TickQueue.clearRefused(context), 0);
    Test.assertEqual(TickQueue.retryRefused(context), 0);
    Test.assertEqual(TickQueue.refusedEntries().size(), 1);
    Test.assertEqual(TickQueue.retryRefused(other), 1);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "b-1");
    Test.assertEqual(RejectedTicks.countFor(TickQueue.loadRejected(), "owner-a"), 2);
    resetTickStores();
    return true;
}

// The store cannot stay full: once the owner deletes or retries, the tick
// that waited at the head of the queue dead-letters on the next drain.
(:test)
function testFullStoreFreesUpAfterDeleteAndTheWaitingTickMovesOn(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3050);
    resetTickStores();
    var full = RejectedTicks.empty();
    for (var index = 0; index < BuildConfig.REJECTED_TICK_MAX; index += 1) {
        full = RejectedTicks.add(full, "owner-a", { "uuid" => "old-" + index.toString() }, "CLIMB_NOT_FOUND",
            BuildConfig.REJECTED_TICK_MAX);
    }
    Application.Storage.setValue(TickQueue.REJECTED_KEY, full);
    TickQueue.enqueue({ "uuid" => "waiting" }, context);
    TickQueue.enqueue({ "uuid" => "behind" }, context);
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "waiting");

    Test.assertEqual(TickQueue.clearRefused(context), BuildConfig.REJECTED_TICK_MAX);
    Test.assertEqual(TickQueue.surfaceCounts()[2], false);
    client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    Test.assertEqual(client.sent[1]["params"]["variables"]["input"]["uuid"], "behind");
    client.sent[1]["callback"].invoke(200, savedReply("behind"));
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries().size(), 1);
    Test.assertEqual(rejectedEntries()[0]["tick"]["uuid"], "waiting");
    Test.assertEqual(observer.calls, 1);
    resetTickStores();
    return true;
}

// Retry all moves a small batch and never into the last free queue slots, so
// a batch the server still refuses cannot block new logs.
(:test)
function testRetryMovesABatchAndLeavesRoomForNewLogs(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3060);
    resetTickStores();
    var store = RejectedTicks.empty();
    for (var index = 0; index < 12; index += 1) {
        store = RejectedTicks.add(store, "owner-a", { "uuid" => "gone-" + index.toString() }, "CLIMB_NOT_FOUND",
            BuildConfig.REJECTED_TICK_MAX);
    }
    Application.Storage.setValue(TickQueue.REJECTED_KEY, store);
    Test.assertEqual(TickQueue.retryRefused(context), BuildConfig.REFUSED_RETRY_BATCH);
    Test.assertEqual(TickQueue.size(), BuildConfig.REFUSED_RETRY_BATCH);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "gone-0");
    Test.assertEqual(rejectedEntries().size(), 12 - BuildConfig.REFUSED_RETRY_BATCH);

    // Queue filled to the headroom line: Retry moves nothing, logging still works.
    var limit = BuildConfig.TICK_QUEUE_MAX - BuildConfig.REFUSED_RETRY_HEADROOM;
    for (var index = TickQueue.size(); index < limit; index += 1) {
        Test.assert(TickQueue.enqueue({ "uuid" => "new-" + index.toString() }, context));
    }
    Test.assertEqual(TickQueue.retryRefused(context), 0);
    Test.assertEqual(TickQueue.size(), limit);
    Test.assertEqual(rejectedEntries().size(), 12 - BuildConfig.REFUSED_RETRY_BATCH);
    Test.assert(TickQueue.enqueue({ "uuid" => "still-room" }, context));
    resetTickStores();
    return true;
}
