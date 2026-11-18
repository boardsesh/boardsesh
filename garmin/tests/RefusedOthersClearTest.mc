using Toybox.Test;
using Toybox.Lang;
using Toybox.Application;
using Toybox.WatchUi;

// Delete other accounts' refused ticks (#7636 decision 2). Offered only while
// the dead-letter store is full, behind its own confirmation. It removes only
// already-refused entries of accounts other than the signed-in owner: the
// owner's entries and every account's queued ticks stay.

// A full store: `ownerCount` entries for owner-a first, the rest split
// between owner-b and owner-c.
(:debug)
function fullRefusedStore(ownerCount as Lang.Number) {
    var store = RejectedTicks.empty();
    for (var index = 0; index < BuildConfig.REJECTED_TICK_MAX; index += 1) {
        var owner = "owner-a";
        if (index >= ownerCount) { owner = index % 2 == 0 ? "owner-b" : "owner-c"; }
        store = RejectedTicks.add(store, owner, { "uuid" => owner + "-" + index.toString() }, "CLIMB_NOT_FOUND",
            BuildConfig.REJECTED_TICK_MAX);
    }
    return store;
}

// Queued ticks for owner-a and owner-b, written straight to the outbox so
// owner-b's queue exists while owner-a is signed in.
(:debug)
function queueForTwoOwners() as Void {
    var envelope = OwnedTickOutbox.load(null);
    envelope = OwnedTickOutbox.append(envelope, "owner-a", { "uuid" => "queued-a" }, BuildConfig.TICK_QUEUE_MAX);
    envelope = OwnedTickOutbox.append(envelope, "owner-b", { "uuid" => "queued-b-1" }, BuildConfig.TICK_QUEUE_MAX);
    envelope = OwnedTickOutbox.append(envelope, "owner-b", { "uuid" => "queued-b-2" }, BuildConfig.TICK_QUEUE_MAX);
    Application.Storage.setValue(TickQueue.KEY, envelope);
}

(:debug)
function assertBothQueuesUntouched() as Void {
    var envelope = TickQueue.loadEnvelope();
    var queueA = OwnedTickOutbox.forOwner(envelope, "owner-a");
    var queueB = OwnedTickOutbox.forOwner(envelope, "owner-b");
    Test.assertEqual(queueA.size(), 1);
    Test.assertEqual(queueA[0]["uuid"], "queued-a");
    Test.assertEqual(queueB.size(), 2);
    Test.assertEqual(queueB[0]["uuid"], "queued-b-1");
    Test.assertEqual(queueB[1]["uuid"], "queued-b-2");
}

(:test)
function testOthersCountIsZeroBelowTheCap(logger as Test.Logger) as Lang.Boolean {
    var store = RejectedTicks.empty();
    for (var index = 0; index < BuildConfig.REJECTED_TICK_MAX - 1; index += 1) {
        store = RejectedTicks.add(store, "owner-b", { "uuid" => "b-" + index.toString() }, "CLIMB_NOT_FOUND",
            BuildConfig.REJECTED_TICK_MAX);
    }
    Test.assertEqual(RejectedTicks.countOthersWhenFull(store, "owner-a", BuildConfig.REJECTED_TICK_MAX), 0);
    Test.assertEqual(RejectedTicks.countOthersWhenFull(fullRefusedStore(3), "owner-a",
        BuildConfig.REJECTED_TICK_MAX), BuildConfig.REJECTED_TICK_MAX - 3);
    Test.assertEqual(RejectedTicks.countOthersWhenFull(fullRefusedStore(BuildConfig.REJECTED_TICK_MAX), "owner-a",
        BuildConfig.REJECTED_TICK_MAX), 0);
    Test.assertEqual(RejectedTicks.countOthersWhenFull({ "version" => 9, "entries" => [] }, "owner-a",
        BuildConfig.REJECTED_TICK_MAX), 0);
    Test.assertEqual(RejectedTicks.countOthersWhenFull(fullRefusedStore(3), null,
        BuildConfig.REJECTED_TICK_MAX), 0);
    return true;
}

// Below the cap the action is not offered and does nothing if called.
(:test)
function testDeleteOthersIsNotOfferedBelowTheCap(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3100);
    resetTickStores();
    Application.Storage.setValue(TickQueue.REJECTED_KEY, refusedFixtureStore());
    var counts = TickQueue.surfaceCounts();
    Test.assertEqual(counts[0], 2);
    Test.assertEqual(counts[2], false);
    Test.assertEqual(counts[3], 0);
    Test.assertEqual(TickQueue.clearOtherOwnersRefused(context), 0);
    Test.assertEqual(rejectedEntries().size(), 3);
    Test.assertEqual(RejectedTicks.countFor(TickQueue.loadRejected(), "owner-b"), 1);

    // With nothing of the owner's and room left, the Refused ticks row stays hidden.
    Application.Storage.setValue(TickQueue.REJECTED_KEY,
        RejectedTicks.add(RejectedTicks.empty(), "owner-b", { "uuid" => "b-1" }, "INVALID_INPUT",
            BuildConfig.REJECTED_TICK_MAX));
    Test.assertEqual(TickQueue.refusedMenuShown(TickQueue.surfaceCounts()), false);
    resetTickStores();
    return true;
}

// At the cap it is offered with the other accounts' count, and the Refused
// ticks row shows even when the signed-in owner has no entries.
(:test)
function testDeleteOthersIsOfferedAtTheCap(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 3110);
    resetTickStores();
    Application.Storage.setValue(TickQueue.REJECTED_KEY, fullRefusedStore(0));
    var counts = TickQueue.surfaceCounts();
    Test.assertEqual(counts[0], 0);
    Test.assertEqual(counts[2], true);
    Test.assertEqual(counts[3], BuildConfig.REJECTED_TICK_MAX);
    Test.assertEqual(TickQueue.refusedMenuShown(counts), true);

    Application.Storage.setValue(TickQueue.REJECTED_KEY, fullRefusedStore(4));
    counts = TickQueue.surfaceCounts();
    Test.assertEqual(counts[0], 4);
    Test.assertEqual(counts[3], BuildConfig.REJECTED_TICK_MAX - 4);
    Test.assertEqual(TickQueue.refusedMenuShown(counts), true);

    // Full with only the owner's entries: nothing of anyone else's to offer.
    Application.Storage.setValue(TickQueue.REJECTED_KEY, fullRefusedStore(BuildConfig.REJECTED_TICK_MAX));
    Test.assertEqual(TickQueue.surfaceCounts()[3], 0);
    resetTickStores();
    return true;
}

// Yes removes only other accounts' refused entries. The owner's entries and
// every account's queued ticks stay, in order.
(:test)
function testDeleteOthersRemovesOnlyOtherAccountsRefusedTicks(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3120);
    resetTickStores();
    queueForTwoOwners();
    Application.Storage.setValue(TickQueue.REJECTED_KEY, fullRefusedStore(4));
    Test.assertEqual(TickQueue.clearOtherOwnersRefused(context), BuildConfig.REJECTED_TICK_MAX - 4);
    var entries = rejectedEntries();
    Test.assertEqual(entries.size(), 4);
    for (var index = 0; index < entries.size(); index += 1) {
        Test.assertEqual(entries[index]["owner"], "owner-a");
        Test.assertEqual(entries[index]["tick"]["uuid"], "owner-a-" + index.toString());
    }
    assertBothQueuesUntouched();
    // No longer full: the action is gone and a second call does nothing.
    Test.assertEqual(TickQueue.surfaceCounts()[2], false);
    Test.assertEqual(TickQueue.surfaceCounts()[3], 0);
    Test.assertEqual(TickQueue.clearOtherOwnersRefused(context), 0);
    Test.assertEqual(rejectedEntries().size(), 4);
    assertBothQueuesUntouched();
    resetTickStores();
    return true;
}

// A failed write deletes nothing; a stale login's context does nothing.
(:test)
function testDeleteOthersFailureOrStaleLoginKeepsEverything(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3130);
    resetTickStores();
    queueForTwoOwners();
    Application.Storage.setValue(TickQueue.REJECTED_KEY, fullRefusedStore(2));
    var refusing = new RefusingWatchStore();
    refusing.refuseKey = TickQueue.REJECTED_KEY;
    WatchStore.backend = refusing;
    Test.assertEqual(TickQueue.clearOtherOwnersRefused(context), 0);
    WatchStore.backend = new WatchObjectStore();
    Test.assertEqual(rejectedEntries().size(), BuildConfig.REJECTED_TICK_MAX);

    installAuthFixture("owner-b", 3140);
    Test.assertEqual(TickQueue.clearOtherOwnersRefused(context), 0);
    Test.assertEqual(rejectedEntries().size(), BuildConfig.REJECTED_TICK_MAX);
    assertBothQueuesUntouched();
    resetTickStores();
    return true;
}

// No on the confirmation deletes nothing, and neither does a Yes from a login
// that is no longer the signed-in one.
(:test)
function testDeleteOthersConfirmationCancelDeletesNothing(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3150);
    resetTickStores();
    queueForTwoOwners();
    Application.Storage.setValue(TickQueue.REJECTED_KEY, fullRefusedStore(3));
    Test.assertEqual(new RefusedDeleteOthersConfirmDelegate(context).onResponse(WatchUi.CONFIRM_NO), true);
    Test.assertEqual(rejectedEntries().size(), BuildConfig.REJECTED_TICK_MAX);
    Test.assertEqual(RejectedTicks.countFor(TickQueue.loadRejected(), "owner-a"), 3);
    assertBothQueuesUntouched();

    installAuthFixture("owner-b", 3160);
    Test.assertEqual(new RefusedDeleteOthersConfirmDelegate(context).onResponse(WatchUi.CONFIRM_YES), true);
    Test.assertEqual(rejectedEntries().size(), BuildConfig.REJECTED_TICK_MAX);
    assertBothQueuesUntouched();
    resetTickStores();
    return true;
}
