using Toybox.Test;
using Toybox.Lang;

(:test)
function testOwnedOutboxQuarantinesLegacyWithoutGuessingAnOwner(logger as Test.Logger) as Lang.Boolean {
    var old = [{ "uuid" => "legacy", "status" => "send" }, { "status" => "attempt" }];
    var state = OwnedTickOutbox.load(old);
    Test.assertEqual(state["unowned"].size(), 2);
    Test.assertEqual(state["unowned"][1]["status"], "attempt");
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "first").size(), 0);
    state["unowned"][0]["status"] = "changed";
    Test.assertEqual(old[0]["status"], "send");
    return true;
}

(:test)
function testOwnedOutboxSeparatesSameUuidAcrossOwners(logger as Test.Logger) as Lang.Boolean {
    var state = OwnedTickOutbox.load(null);
    state = OwnedTickOutbox.append(state, "first", { "uuid" => "shared", "status" => "send" }, 3);
    state = OwnedTickOutbox.append(state, "second", { "uuid" => "shared", "status" => "attempt" }, 3);
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "first")[0]["status"], "send");
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "second")[0]["status"], "attempt");
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "other").size(), 0);
    return true;
}

(:test)
function testOwnedOutboxAcknowledgementCannotRemoveAnotherOwnersTick(logger as Test.Logger) as Lang.Boolean {
    var state = OwnedTickOutbox.load([{ "uuid" => "shared" }]);
    state = OwnedTickOutbox.append(state, "first", { "uuid" => "shared" }, 3);
    state = OwnedTickOutbox.append(state, "second", { "uuid" => "shared" }, 3);
    var acknowledged = OwnedTickOutbox.acknowledge(state, "first", "shared");
    Test.assertEqual(OwnedTickOutbox.forOwner(acknowledged, "first").size(), 0);
    Test.assertEqual(OwnedTickOutbox.forOwner(acknowledged, "second").size(), 1);
    Test.assertEqual(acknowledged["unowned"].size(), 1);
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "first").size(), 1);
    Test.assertEqual(acknowledged["owners"].hasKey("first"), false);
    return true;
}

(:test)
function testOwnedOutboxCapacityRefusesWithoutDiscardingSavedTicks(logger as Test.Logger) as Lang.Boolean {
    var state = OwnedTickOutbox.load([{ "uuid" => "legacy" }]);
    state = OwnedTickOutbox.append(state, "first", { "uuid" => "oldest" }, 2);
    state = OwnedTickOutbox.append(state, "second", { "uuid" => "newest" }, 2);
    Test.assertEqual(OwnedTickOutbox.append(state, "third", { "uuid" => "overflow" }, 2) == null, true);
    Test.assertEqual(OwnedTickOutbox.ownedCount(state), 2);
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "first")[0]["uuid"], "oldest");
    Test.assertEqual(state["unowned"][0]["uuid"], "legacy");
    return true;
}

(:test)
function testOwnedOutboxDuplicateRetryAtCapacityKeepsOriginalPayload(logger as Test.Logger) as Lang.Boolean {
    var state = OwnedTickOutbox.load(null);
    state = OwnedTickOutbox.append(state, "first", { "uuid" => "same", "status" => "send" }, 1);
    var retry = OwnedTickOutbox.append(state, "first", { "uuid" => "same", "status" => "attempt" }, 1);
    Test.assertEqual(OwnedTickOutbox.ownedCount(retry), 1);
    Test.assertEqual(OwnedTickOutbox.forOwner(retry, "first")[0]["status"], "send");
    return true;
}

(:test)
function testOwnedOutboxRefusesUnknownOrCorruptStorage(logger as Test.Logger) as Lang.Boolean {
    var unknown = { "version" => 99, "owners" => {}, "unowned" => [] };
    Test.assertEqual(OwnedTickOutbox.load(unknown) == null, true);
    Test.assertEqual(unknown["version"], 99);
    Test.assertEqual(OwnedTickOutbox.load("corrupt") == null, true);
    Test.assertEqual(OwnedTickOutbox.load({ "version" => 2, "owners" => { "first" => ["bad"] }, "unowned" => [] }) == null, true);
    return true;
}

(:test)
function testOwnedOutboxRequiresExplicitNonemptyOwnerAndUuid(logger as Test.Logger) as Lang.Boolean {
    var state = OwnedTickOutbox.load(null);
    Test.assertEqual(OwnedTickOutbox.append(state, null, { "uuid" => "tick" }, 2) == null, true);
    Test.assertEqual(OwnedTickOutbox.append(state, "", { "uuid" => "tick" }, 2) == null, true);
    Test.assertEqual(OwnedTickOutbox.append(state, "first", {}, 2) == null, true);
    Test.assertEqual(OwnedTickOutbox.acknowledge(state, null, "tick") == null, true);
    Test.assertEqual(OwnedTickOutbox.ownedCount(state), 0);
    return true;
}

(:test)
function testOwnedOutboxCopiesNestedInputsAndReturnedTicks(logger as Test.Logger) as Lang.Boolean {
    var original = OwnedTickOutbox.load(null);
    var tick = { "uuid" => "nested", "options" => { "items" => ["kept"] } };
    var next = OwnedTickOutbox.append(original, "first", tick, 2);
    tick["options"]["items"][0] = "caller changed";
    var returned = OwnedTickOutbox.forOwner(next, "first");
    Test.assertEqual(returned[0]["options"]["items"][0], "kept");
    returned[0]["options"]["items"][0] = "reader changed";
    Test.assertEqual(OwnedTickOutbox.forOwner(next, "first")[0]["options"]["items"][0], "kept");
    Test.assertEqual(OwnedTickOutbox.ownedCount(original), 0);
    return true;
}

(:test)
function testOwnedOutboxBoundsRecursiveStorageBeforeCopying(logger as Test.Logger) as Lang.Boolean {
    var deep = { "child" => null };
    for (var depth = 0; depth < 12; depth += 1) { deep = { "child" => deep }; }
    Test.assertEqual(OwnedTickOutbox.load([deep]) == null, true);
    return true;
}

(:test)
function testOwnedOutboxRepeatedAcknowledgementsAreScopedAndIdempotent(logger as Test.Logger) as Lang.Boolean {
    var state = OwnedTickOutbox.load(null);
    state = OwnedTickOutbox.append(state, "first", { "uuid" => "tick" }, 2);
    var untouched = OwnedTickOutbox.acknowledge(state, "second", "tick");
    Test.assertEqual(OwnedTickOutbox.forOwner(untouched, "first").size(), 1);
    state = OwnedTickOutbox.acknowledge(state, "first", "tick");
    state = OwnedTickOutbox.acknowledge(state, "first", "tick");
    Test.assertEqual(OwnedTickOutbox.ownedCount(state), 0);
    state = OwnedTickOutbox.append(state, "first", { "uuid" => "remove" }, 2);
    state = OwnedTickOutbox.append(state, "first", { "uuid" => "keep" }, 2);
    state = OwnedTickOutbox.acknowledge(state, "first", "remove");
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "first").size(), 1);
    Test.assertEqual(OwnedTickOutbox.forOwner(state, "first")[0]["uuid"], "keep");
    state = OwnedTickOutbox.acknowledge(state, "first", "keep");
    Test.assertEqual(OwnedTickOutbox.ownedCount(state), 0);
    Test.assertEqual(state["owners"].hasKey("first"), false);
    return true;
}

(:test)
function testOwnedOutboxProducedStatesRoundTripAtDepthBoundary(logger as Test.Logger) as Lang.Boolean {
    var nested = "kept";
    for (var depth = 0; depth < 4; depth += 1) { nested = { "child" => nested }; }
    var state = OwnedTickOutbox.load(null);
    var accepted = OwnedTickOutbox.append(state, "first", { "uuid" => "deep", "nested" => nested }, 2);
    Test.assertEqual(accepted != null, true);
    Test.assertEqual(OwnedTickOutbox.load(accepted) != null, true);
    var tooDeep = { "child" => nested };
    Test.assertEqual(OwnedTickOutbox.append(state, "first", { "uuid" => "deep", "nested" => tooDeep }, 2) == null, true);
    Test.assertEqual(OwnedTickOutbox.ownedCount(state), 0);
    return true;
}

(:test)
function testOwnedOutboxLegacyWrapRespectsEnvelopeDepth(logger as Test.Logger) as Lang.Boolean {
    var nested = "kept";
    for (var depth = 0; depth < 6; depth += 1) { nested = { "child" => nested }; }
    var accepted = OwnedTickOutbox.load([nested]);
    Test.assertEqual(accepted != null, true);
    Test.assertEqual(OwnedTickOutbox.load(accepted) != null, true);
    Test.assertEqual(OwnedTickOutbox.load([{ "child" => nested }]) == null, true);
    return true;
}
