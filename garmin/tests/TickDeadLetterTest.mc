using Toybox.Test;
using Toybox.Lang;
using Toybox.Application;

// Final pre-G2 access tokens. Payload of LEGACY_JWT_OWNER_A:
// {"sub":"owner-a","gen":1,"ngen":0,"sid":"s>>?~~","iat":1700000000,...}
// (the sid makes the base64url payload carry a "_"). 1700000000 is
// 2023-11-14T22:13:20Z, so the adoption floor is 2023-11-15T22:13:20Z.
(:debug) const LEGACY_JWT_OWNER_A = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lci1hIiwiZ2VuIjoxLCJuZ2VuIjowLCJzaWQiOiJzPj4_fn4iLCJpYXQiOjE3MDAwMDAwMDAsImlzcyI6ImJvYXJkc2VzaCIsImF1ZCI6ImJvYXJkc2VzaC1hcHAiLCJleHAiOjE3MDA2MDQ4MDB9.c2ln";
(:debug) const LEGACY_JWT_NO_IAT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lci1hIiwiZXhwIjoxfQ.c2ln";
(:debug) const LEGACY_JWT_DUPLICATE_SUB = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lci1hIiwic3ViIjoib3duZXItYiIsImlhdCI6MTcwMDAwMDAwMH0.c2ln";
(:debug) const LEGACY_JWT_ESCAPED_SUB = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25cImVyIiwiaWF0IjoxNzAwMDAwMDAwfQ.c2ln";
// {"sub":"owner-a","iat":1.7e9} must not read as iat 1.
(:debug) const LEGACY_JWT_FLOAT_IAT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lci1hIiwiaWF0IjoxLjdlOX0.c2ln";
// {"sub":"owner-a","iat":1700000000} with the claim last, ended by "}".
(:debug) const LEGACY_JWT_LAST_IAT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lci1hIiwiaWF0IjoxNzAwMDAwMDAwfQ.c2ln";

(:debug)
function resetTickStores() as Void {
    Application.Storage.setValue(TickQueue.KEY, OwnedTickOutbox.load(null));
    Application.Storage.setValue(TickQueue.REJECTED_KEY, RejectedTicks.empty());
    Application.Storage.deleteValue(TokenStore.KEY_JWT);
    WatchStore.backend = new WatchObjectStore();
}

(:debug)
function rejectedEntries() as Lang.Array {
    return (Application.Storage.getValue(TickQueue.REJECTED_KEY) as Lang.Dictionary)["entries"];
}

(:debug)
function graphqlError(code, message) {
    var error = { "message" => message, "path" => ["saveTick"] };
    if (code != null) { error["extensions"] = { "code" => code }; }
    return { "errors" => [error], "data" => null };
}

(:test)
function testReplyClassificationFollowsTheServerHandler(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(TickQueue.classifyFlushResult(200, savedReply("tick"), "tick"), :success);
    var rejected = [
        [200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"), "CLIMB_NOT_FOUND"],
        [200, graphqlError("TICK_UUID_CONFLICT", "Tick UUID is already in use"), "TICK_UUID_CONFLICT"],
        [200, graphqlError(null, "Invalid input: Climbed at must be a valid date"), "INVALID_INPUT"],
        [400, nullStateFieldReply("boardType", "String!"), "NULL_STATE_FIELD"],
        [400, nullStateFieldReply("climbUuid", "String!"), "NULL_STATE_FIELD"],
        [400, nullStateFieldReply("isBenchmark", "Boolean!"), "NULL_STATE_FIELD"]
    ];
    for (var index = 0; index < rejected.size(); index += 1) {
        var row = rejected[index];
        Test.assertEqual(TickQueue.classifyFlushResult(row[0], row[1], "tick"), :rejected);
        Test.assertEqual(TickQueue.rejectionReason(row[0], row[1]), row[2]);
    }
    var mixed = graphqlError("CLIMB_NOT_FOUND", "Climb not found");
    mixed["errors"].add({ "message" => "Something went wrong", "extensions" => { "code" => "INTERNAL_SERVER_ERROR" } });
    var retried = [
        [200, graphqlError(null, "Authentication required to perform this operation")],
        [200, graphqlError("INTERNAL_SERVER_ERROR", "Something went wrong on our end. Please try again.")],
        [503, graphqlError("INTERNAL_SERVER_ERROR", "Something went wrong on our end. Please try again.")],
        [503, graphqlError("SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable")],
        [401, graphqlError("UNAUTHENTICATED", "Authentication is required")],
        [200, graphqlError("UNAUTHENTICATED", "Authentication is required")],
        [200, graphqlError("SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable")],
        [200, graphqlError("RATE_LIMITED", "Too many requests")],
        [200, graphqlError("FORBIDDEN", "Not allowed")],
        // Verdicts on the fixed query or schema hit every tick alike.
        [200, graphqlError("GRAPHQL_VALIDATION_FAILED", "Cannot query field \"uuid\" on type \"Tick\".")],
        [400, nullStateFieldReply("quality", "Int!")],
        [400, nullStateFieldReply("status", "TickStatus!")],
        [400, { "errors" => [{ "message" => "Variable \"$input\" got invalid value { uuid: \"tick\", extra: 1 }; Field \"extra\" is not defined by type \"SaveTickInput\"." }] }],
        [400, { "errors" => [{ "message" => "Variable \"$input\" got invalid value \"sent\" at \"input.status\"; Value \"sent\" does not exist in \"TickStatus\" enum." }] }],
        [400, { "errors" => [{ "message" => "POST body sent invalid JSON.", "extensions" => { "code" => "BAD_REQUEST" } }] }],
        [400, null],
        [200, graphqlError(7, "Invalid input: numeric code is not a server shape")],
        [200, { "errors" => ["refused"], "data" => { "saveTick" => { "uuid" => "tick" } } }],
        [200, { "errors" => [], "data" => null }],
        [200, mixed],
        [200, savedReply("other")],
        [200, null],
        [404, graphqlError("CLIMB_NOT_FOUND", "edge page")],
        [-104, null],
        [-400, null],
        [BsResponse.STALE, null]
    ];
    for (var index = 0; index < retried.size(); index += 1) {
        Test.assertEqual(TickQueue.classifyFlushResult(retried[index][0], retried[index][1], "tick"), :retry);
        Test.assertEqual(TickQueue.rejectionReason(retried[index][0], retried[index][1]) == null, true);
    }
    return true;
}

(:test)
function testRejectionMidQueueDeadLettersItAndSendsLaterTicks(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 2000);
    resetTickStores();
    Test.assert(TickQueue.enqueue({ "uuid" => "first" }, context));
    Test.assert(TickQueue.enqueue({ "uuid" => "gone", "climbUuid" => "deleted-spray" }, context));
    Test.assert(TickQueue.enqueue({ "uuid" => "last" }, context));
    var client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    client.sent[0]["callback"].invoke(200, savedReply("first"));
    Test.assertEqual(client.sent[1]["params"]["variables"]["input"]["uuid"], "gone");
    client.sent[1]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    Test.assertEqual(client.sent.size(), 3);
    Test.assertEqual(client.sent[2]["params"]["variables"]["input"]["uuid"], "last");
    client.sent[2]["callback"].invoke(200, savedReply("last"));
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(observer.calls, 1);
    var entries = rejectedEntries();
    Test.assertEqual(entries.size(), 1);
    Test.assertEqual(entries[0]["owner"], "owner-a");
    Test.assertEqual(entries[0]["reason"], "CLIMB_NOT_FOUND");
    Test.assertEqual(entries[0]["tick"]["climbUuid"], "deleted-spray");
    Test.assertEqual(entries[0].hasKey("seen"), false);
    Test.assertEqual(TickQueue.surfaceCounts()[2], false);
    return true;
}

(:test)
function testSecondSameReasonRefusalInOneDrainStopsAndKeepsTheTick(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 2050);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "first-gone" }, context);
    TickQueue.enqueue({ "uuid" => "second-gone" }, context);
    TickQueue.enqueue({ "uuid" => "conflict" }, context);
    var client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    client.sent[1]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    // Possibly the server, not the tick: keep it and stop this drain.
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(observer.calls, 1);
    Test.assertEqual(rejectedEntries().size(), 1);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "second-gone");
    // The next drain dead-letters it, and a different reason still moves on.
    client = new CapturedBsClient();
    observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    client.sent[1]["callback"].invoke(200, graphqlError("TICK_UUID_CONFLICT", "Tick UUID is already in use"));
    Test.assertEqual(rejectedEntries().size(), 3);
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(observer.calls, 1);
    return true;
}

(:test)
function testTransportAndAuthFailuresDeadLetterNothingAndKeepOrder(logger as Test.Logger) as Lang.Boolean {
    // [status, body, whether the client refreshes before the drain hears it]
    var failures = [
        [-104, null, false],
        [-2, null, false],
        [401, null, true],
        [200, graphqlError(null, "Authentication required to perform this operation"), true],
        [503, graphqlError("INTERNAL_SERVER_ERROR", "Something went wrong on our end. Please try again."), false],
        [429, null, false]
    ];
    for (var index = 0; index < failures.size(); index += 1) {
        var context = installAuthFixture("owner-a", 2100 + index * 10);
        resetTickStores();
        TickQueue.enqueue({ "uuid" => "front" }, context);
        TickQueue.enqueue({ "uuid" => "back" }, context);
        var client = new CapturedBsClient();
        var observer = new FlushCompletionObserver();
        new TickFlusher(client).start(observer.method(:done));
        client.sent[0]["callback"].invoke(failures[index][0], failures[index][1]);
        // A 401, or the 200 auth error an expired token gets, asks the client
        // to refresh first; the drain has not settled.
        if (failures[index][2] == true) {
            Test.assertEqual(observer.calls, 0);
            Test.assertEqual(client.sent.size(), 2);
            Test.assertEqual(client.sent[1]["params"]["refreshToken"], "refresh");
        } else {
            Test.assertEqual(observer.calls, 1);
            Test.assertEqual(client.sent.size(), 1);
        }
        Test.assertEqual(rejectedEntries().size(), 0);
        Test.assertEqual(TickQueue.size(), 2);
        Test.assertEqual(TickQueue.all()[0]["uuid"], "front");
        Test.assertEqual(TickQueue.all()[1]["uuid"], "back");
    }
    return true;
}

(:test)
function testExpiredTokenDrainRefreshesAndSendsEachTickOnce(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 2170);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "expired" }, context);
    TickQueue.enqueue({ "uuid" => "behind" }, context);
    var client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError(null, "Authentication required to perform this operation"));
    Test.assertEqual(observer.calls, 0);
    Test.assertEqual(client.sent[1]["params"]["refreshToken"], "refresh");
    var rotated = authResponse("owner-a");
    rotated["jwt"] = "rotated-access";
    client.sent[1]["callback"].invoke(200, rotated);
    // The same tick, same UUID, once more with the new token.
    Test.assertEqual(client.sent.size(), 3);
    Test.assertEqual(client.sent[2]["token"], "rotated-access");
    Test.assertEqual(client.sent[2]["params"]["variables"]["input"]["uuid"], "expired");
    client.sent[2]["callback"].invoke(200, savedReply("expired"));
    Test.assertEqual(client.sent[3]["params"]["variables"]["input"]["uuid"], "behind");
    client.sent[3]["callback"].invoke(200, savedReply("behind"));
    Test.assertEqual(client.sent.size(), 4);
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries().size(), 0);
    Test.assertEqual(observer.calls, 1);
    return true;
}

// GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION: a refresh the server rejects signs
// the watch out but keeps every queued tick, and a same-account re-pair
// sends them.
(:test)
function testRejectedRefreshAfterTickAuthErrorKeepsTheQueueForRepair(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 2180);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "kept-1" }, context);
    TickQueue.enqueue({ "uuid" => "kept-2" }, context);
    var client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError(null, "Authentication required to perform this operation"));
    client.sent[1]["callback"].invoke(401, { "error" => "Invalid refresh token" });
    Test.assertEqual(client.lost, 1);
    Test.assertEqual(TokenStore.hasTokens(), false);
    Test.assertEqual(observer.calls, 1);
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(rejectedEntries().size(), 0);
    var kept = OwnedTickOutbox.forOwner(TickQueue.loadEnvelope(), "owner-a");
    Test.assertEqual(kept.size(), 2);
    Test.assertEqual(kept[0]["uuid"], "kept-1");
    Test.assertEqual(kept[1]["uuid"], "kept-2");

    installAuthFixture("owner-a", 2190);
    client = new CapturedBsClient();
    observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    Test.assertEqual(client.sent[0]["params"]["variables"]["input"]["uuid"], "kept-1");
    client.sent[0]["callback"].invoke(200, savedReply("kept-1"));
    client.sent[1]["callback"].invoke(200, savedReply("kept-2"));
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(observer.calls, 1);
    return true;
}

(:test)
function testRepeatedUuidAcknowledgementSettlesOnceAndWrongUuidRetries(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 2200);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "lost-ack" }, context);
    TickQueue.enqueue({ "uuid" => "next" }, context);
    // First drain: the reply is lost after the server may have saved it.
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(-2, null);
    Test.assertEqual(TickQueue.size(), 2);
    // Second drain: the server ignores the repeated UUID and answers the stored tick.
    client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    Test.assertEqual(client.sent[0]["params"]["variables"]["input"]["uuid"], "lost-ack");
    client.sent[0]["callback"].invoke(200, savedReply("lost-ack"));
    Test.assertEqual(TickQueue.size(), 1);
    // An acknowledgement naming another UUID is not one for this tick.
    client.sent[1]["callback"].invoke(200, savedReply("lost-ack"));
    Test.assertEqual(TickQueue.size(), 1);
    Test.assertEqual(TickQueue.all()[0]["uuid"], "next");
    Test.assertEqual(rejectedEntries().size(), 0);
    Test.assertEqual(observer.calls, 1);
    return true;
}

(:test)
function testFullDeadLetterStoreNeverEvictsAndKeepsTheRefusalQueued(logger as Test.Logger) as Lang.Boolean {
    var store = RejectedTicks.empty();
    store = RejectedTicks.add(store, "owner-a", { "uuid" => "one" }, "CLIMB_NOT_FOUND", 2);
    store = RejectedTicks.add(store, "owner-b", { "uuid" => "two" }, "NULL_STATE_FIELD", 2);
    Test.assertEqual(RejectedTicks.isFull(store, 2), true);
    Test.assertEqual(RejectedTicks.add(store, "owner-a", { "uuid" => "three" }, "CLIMB_NOT_FOUND", 2) == null, true);
    // The same owner/UUID again is not a second entry, even when full.
    Test.assertEqual(RejectedTicks.add(store, "owner-a", { "uuid" => "one" }, "CLIMB_NOT_FOUND", 2)["entries"].size(), 2);
    Test.assertEqual(RejectedTicks.load({ "version" => 9, "entries" => [] }) == null, true);
    Test.assertEqual(RejectedTicks.load({ "version" => 1, "entries" => [{ "owner" => "owner-a" }] }) == null, true);

    // Store full + another permanent refusal: nothing is evicted, the tick
    // stays at the head of the queue, and the ticks behind it are not sent.
    var context = installAuthFixture("owner-a", 2300);
    resetTickStores();
    var full = RejectedTicks.empty();
    for (var index = 0; index < BuildConfig.REJECTED_TICK_MAX; index += 1) {
        full = RejectedTicks.add(full, "owner-a", { "uuid" => "old-" + index.toString() }, "CLIMB_NOT_FOUND", BuildConfig.REJECTED_TICK_MAX);
    }
    Application.Storage.setValue(TickQueue.REJECTED_KEY, full);
    TickQueue.enqueue({ "uuid" => "refused" }, context);
    TickQueue.enqueue({ "uuid" => "behind" }, context);
    for (var drain = 0; drain < 2; drain += 1) {
        var client = new CapturedBsClient();
        var observer = new FlushCompletionObserver();
        new TickFlusher(client).start(observer.method(:done));
        client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
        Test.assertEqual(client.sent.size(), 1);
        Test.assertEqual(observer.calls, 1);
        Test.assertEqual(TickQueue.size(), 2);
        Test.assertEqual(TickQueue.all()[0]["uuid"], "refused");
        Test.assertEqual(TickQueue.all()[1]["uuid"], "behind");
        Test.assertEqual(rejectedEntries().size(), BuildConfig.REJECTED_TICK_MAX);
        Test.assertEqual(rejectedEntries()[0]["tick"]["uuid"], "old-0");
        Test.assertEqual(rejectedEntries()[BuildConfig.REJECTED_TICK_MAX - 1]["tick"]["uuid"],
            "old-" + (BuildConfig.REJECTED_TICK_MAX - 1).toString());
    }
    // The summary reports the full store, and reading it changes nothing.
    var counts = TickQueue.surfaceCounts();
    Test.assertEqual(counts[0], BuildConfig.REJECTED_TICK_MAX);
    Test.assertEqual(counts[2], true);
    Test.assertEqual(rejectedEntries().size(), BuildConfig.REJECTED_TICK_MAX);
    // Another account sees the store as full too: its next refusal also waits.
    installAuthFixture("owner-b", 2310);
    Test.assertEqual(TickQueue.surfaceCounts()[0], 0);
    Test.assertEqual(TickQueue.surfaceCounts()[2], true);
    resetTickStores();
    return true;
}

(:test)
function testDeadLetterWriteFailureKeepsTheTickQueued(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 2400);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "refused" }, context);
    var store = new RefusingWatchStore();
    store.refuseKey = TickQueue.REJECTED_KEY;
    WatchStore.backend = store;
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("TICK_UUID_CONFLICT", "Tick UUID is already in use"));
    WatchStore.backend = new WatchObjectStore();
    Test.assertEqual(TickQueue.size(), 1);
    Test.assertEqual(rejectedEntries().size(), 0);
    return true;
}

(:test)
function testLiveLogRefusalStaysQueuedUntilTheExitDrain(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 2500);
    resetTickStores();
    var client = new CapturedBsClient();
    Services.client = client;
    Test.assert(new TickLogger({ "uuid" => "live" }).submit());
    client.sent[0]["callback"].invoke(200, graphqlError(null, "Invalid input: Angle is not supported"));
    Test.assertEqual(TickQueue.size(), 1);
    Test.assertEqual(rejectedEntries().size(), 0);
    client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError(null, "Invalid input: Angle is not supported"));
    Test.assertEqual(TickQueue.size(), 0);
    Test.assertEqual(rejectedEntries()[0]["reason"], "INVALID_INPUT");
    return true;
}

(:test)
function testLegacyProofReadsOnlyAWellFormedSubjectAndIssueTime(logger as Test.Logger) as Lang.Boolean {
    var proof = LegacyTickProof.fromJwt(LEGACY_JWT_OWNER_A);
    Test.assertEqual(proof["owner"], "owner-a");
    Test.assertEqual(proof["issuedAt"], 1700000000l);
    Test.assertEqual(LegacyTickProof.fromJwt(LEGACY_JWT_LAST_IAT)["issuedAt"], 1700000000l);
    Test.assertEqual(LegacyTickProof.fromJwt(LEGACY_JWT_FLOAT_IAT) == null, true);
    // Malformed base64 (a 1-mod-4 segment, invalid characters, bytes that are
    // not UTF-8) must refuse without crashing the app.
    var refused = [null, "", "no-dots", "a..b", ".payload.sig", "a.b.c", "a.%%%%.sig", "a.__79.sig",
        LEGACY_JWT_NO_IAT, LEGACY_JWT_DUPLICATE_SUB, LEGACY_JWT_ESCAPED_SUB, 42];
    for (var index = 0; index < refused.size(); index += 1) {
        Test.assertEqual(LegacyTickProof.fromJwt(refused[index]) == null, true);
    }
    Test.assertEqual(TimeUtil.parseIsoUtc("2023-11-14T22:13:20Z"), 1700000000l);
    Test.assertEqual(TimeUtil.parseIsoUtc("1970-01-01T00:00:00Z"), 0l);
    Test.assertEqual(TimeUtil.parseIsoUtc("2024-02-29T00:00:00Z"), 1709164800l);
    Test.assertEqual(TimeUtil.parseIsoUtc("2100-12-31T23:59:59Z"), 4133980799l);
    var badTimes = ["2023-02-31T00:00:00Z", "2023-02-29T00:00:00Z", "2100-02-29T00:00:00Z",
        "2023-11-14T22:13:20.000Z", "2023-11-14 22:13:20Z", "2023-11-14T22:13:20+01",
        "2023-11-14T24:00:00Z", "1969-12-31T23:59:59Z", "yesterday", null];
    for (var index = 0; index < badTimes.size(); index += 1) {
        Test.assertEqual(TimeUtil.parseIsoUtc(badTimes[index]) == null, true);
    }
    return true;
}

// A tick shaped exactly like BsEndpoints.saveTickInput's output.
(:debug)
function fullSizeTick(uuid as Lang.String, climbedAt as Lang.String) as Lang.Dictionary {
    return { "uuid" => uuid, "boardType" => "kilter", "climbUuid" => "C0FFEEC0FFEEC0FFEEC0FFEEC0FFEE00",
        "angle" => 40, "isMirror" => false, "status" => "send", "attemptCount" => 1, "quality" => null,
        "difficulty" => null, "isBenchmark" => false, "comment" => "", "climbedAt" => climbedAt,
        "sessionId" => "3b0f6d6e-8f3c-4d55-9a8e-2c8f0f6c1a77", "layoutId" => 1, "sizeId" => 10,
        "setIds" => "1,20" };
}

// The heaviest single callback the drain can run: refuse the owner's last
// queued tick into a nearly full dead-letter store, then adopt from a full
// on-hold list, all beside another owner's full queue, with full-size ticks.
// This checks behaviour at full size only. The SDK test runner does not
// enforce the bytecode watchdog (a 50-million-iteration probe passed), so
// whether this callback fits on a real watch is a hardware check.
(:test)
function testWorstCaseSingleCallbackWorksAtFullSize(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 2900);
    resetTickStores();
    var other = [];
    for (var index = 0; index < BuildConfig.TICK_QUEUE_MAX - 1; index += 1) {
        other.add(fullSizeTick("other-" + index.toString(), "2026-11-16T10:00:00Z"));
    }
    var legacy = [];
    for (var index = 0; index < BuildConfig.TICK_QUEUE_MAX; index += 1) {
        legacy.add(fullSizeTick("legacy-" + index.toString(), "2023-11-20T10:00:00Z"));
    }
    Application.Storage.setValue(TickQueue.KEY, { "version" => OwnedTickOutbox.VERSION,
        "owners" => { "owner-a" => [fullSizeTick("last", "2026-11-16T10:00:00Z")], "owner-b" => other },
        "unowned" => legacy });
    var entries = [];
    for (var index = 0; index < BuildConfig.REJECTED_TICK_MAX - 1; index += 1) {
        entries.add({ "owner" => "owner-b", "tick" => fullSizeTick("dead-" + index.toString(), "2026-11-16T10:00:00Z"),
            "reason" => "CLIMB_NOT_FOUND" });
    }
    Application.Storage.setValue(TickQueue.REJECTED_KEY, { "version" => RejectedTicks.VERSION, "entries" => entries });
    Application.Storage.setValue(TokenStore.KEY_JWT, LEGACY_JWT_OWNER_A);
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(client.sent[1]["params"]["variables"]["input"]["uuid"], "legacy-0");
    Test.assertEqual(rejectedEntries().size(), BuildConfig.REJECTED_TICK_MAX);
    resetTickStores();
    return true;
}

(:debug)
function legacyQueue() as Lang.Array {
    return [
        { "uuid" => "before-token", "climbedAt" => "2023-11-10T12:00:00Z" },
        { "uuid" => "inside-skew", "climbedAt" => "2023-11-15T20:00:00Z" },
        { "climbedAt" => "2023-11-20T12:00:00Z" },
        { "uuid" => "unreadable-time", "climbedAt" => "yesterday" },
        { "uuid" => "after-token", "climbedAt" => "2023-11-16T09:00:00Z" },
        { "uuid" => "later", "climbedAt" => "2023-11-18T09:00:00Z" }
    ];
}

(:test)
function testLegacyTickAdoptedOnlyForTheTokenOwnerAfterTheToken(logger as Test.Logger) as Lang.Boolean {
    // Another verified account is signed in: nothing is adopted or sent.
    installAuthFixture("owner-b", 2600);
    resetTickStores();
    Application.Storage.setValue(TickQueue.KEY, legacyQueue());
    Application.Storage.setValue(TokenStore.KEY_JWT, LEGACY_JWT_OWNER_A);
    var client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    Test.assertEqual(client.sent.size(), 0);
    Test.assertEqual(observer.calls, 1);
    Test.assertEqual((Application.Storage.getValue(TickQueue.KEY) as Lang.Array).size(), 6);

    // The token's own subject: only ticks logged a day after the token are
    // adopted, oldest first, one at a time.
    installAuthFixture("owner-a", 2610);
    client = new CapturedBsClient();
    observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(client.sent[0]["params"]["variables"]["input"]["uuid"], "after-token");
    var envelope = TickQueue.loadEnvelope();
    Test.assertEqual(envelope["unowned"].size(), 5);
    Test.assertEqual(OwnedTickOutbox.forOwner(envelope, "owner-a").size(), 1);
    client.sent[0]["callback"].invoke(200, savedReply("after-token"));
    Test.assertEqual(client.sent[1]["params"]["variables"]["input"]["uuid"], "later");
    client.sent[1]["callback"].invoke(200, savedReply("later"));
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(observer.calls, 1);
    envelope = TickQueue.loadEnvelope();
    Test.assertEqual(envelope["unowned"].size(), 4);
    Test.assertEqual(envelope["unowned"][0]["uuid"], "before-token");
    Test.assertEqual(envelope["unowned"][1]["uuid"], "inside-skew");
    Test.assertEqual(envelope["unowned"][3]["uuid"], "unreadable-time");
    Test.assertEqual(TickQueue.surfaceCounts()[1], 4);
    return true;
}

(:test)
function testAdoptionSkipsQueuedUuidsAndRespectsCapacity(logger as Test.Logger) as Lang.Boolean {
    var proof = { "owner" => "owner-a", "issuedAt" => 1700000000l };
    var state = OwnedTickOutbox.load(legacyQueue());
    state = OwnedTickOutbox.append(state, "owner-a", { "uuid" => "after-token", "climbedAt" => "2023-11-16T09:00:00Z" }, 3);
    var adopted = OwnedTickOutbox.adoptOne(state, "owner-a", proof, BuildConfig.LEGACY_ADOPT_SKEW_SEC, 3);
    // The owner already queues "after-token", so the next provable tick moves.
    Test.assertEqual(OwnedTickOutbox.forOwner(adopted, "owner-a")[0]["uuid"], "later");
    Test.assertEqual(OwnedTickOutbox.forOwner(adopted, "owner-a")[1]["uuid"], "after-token");
    Test.assertEqual(adopted["unowned"].size(), 5);
    // The input envelope is unchanged (copy-on-write).
    Test.assertEqual(state["unowned"].size(), 6);
    // Shared capacity counts every owner; a full queue adopts nothing.
    state = OwnedTickOutbox.append(state, "owner-b", { "uuid" => "b-1" }, 3);
    state = OwnedTickOutbox.append(state, "owner-b", { "uuid" => "b-2" }, 3);
    Test.assertEqual(OwnedTickOutbox.adoptOne(state, "owner-a", proof, BuildConfig.LEGACY_ADOPT_SKEW_SEC, 3) == null, true);
    Test.assertEqual(OwnedTickOutbox.adoptOne(state, "owner-b", proof, BuildConfig.LEGACY_ADOPT_SKEW_SEC, 9) == null, true);
    return true;
}

(:test)
function testAdoptedTickWaitsQueuedWhenOfflineAndNoProofMeansNoAdoption(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 2700);
    resetTickStores();
    Application.Storage.setValue(TickQueue.KEY, legacyQueue());
    Application.Storage.setValue(TokenStore.KEY_JWT, LEGACY_JWT_OWNER_A);
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(-104, null);
    // Offline: one adopted tick waits in the owner's queue; the rest stay held.
    Test.assertEqual(TickQueue.size(), 1);
    Test.assertEqual(TickQueue.loadEnvelope()["unowned"].size(), 5);
    Test.assertEqual(TickQueue.enqueue({ "uuid" => "new-log" }, context), true);

    var tokens = [LEGACY_JWT_NO_IAT, LEGACY_JWT_ESCAPED_SUB, "not-a-token", null];
    for (var index = 0; index < tokens.size(); index += 1) {
        installAuthFixture("owner-a", 2710 + index * 10);
        resetTickStores();
        Application.Storage.setValue(TickQueue.KEY, legacyQueue());
        if (tokens[index] != null) { Application.Storage.setValue(TokenStore.KEY_JWT, tokens[index]); }
        client = new CapturedBsClient();
        new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
        Test.assertEqual(client.sent.size(), 0);
        Test.assertEqual(TickQueue.loadEnvelope()["unowned"].size(), 6);
    }
    resetTickStores();
    return true;
}

(:test)
function testQueuedAndRefusedTicksAreNeverSentUnderAnotherAccount(logger as Test.Logger) as Lang.Boolean {
    var first = installAuthFixture("owner-a", 2800);
    resetTickStores();
    TickQueue.enqueue({ "uuid" => "a-refused" }, first);
    TickQueue.enqueue({ "uuid" => "a-queued" }, first);
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    client.sent[0]["callback"].invoke(200, graphqlError("CLIMB_NOT_FOUND", "Climb not found"));
    client.sent[1]["callback"].invoke(-104, null);
    Application.Storage.setValue(TokenStore.KEY_JWT, LEGACY_JWT_OWNER_A);

    var second = installAuthFixture("owner-b", 2810);
    Test.assertEqual(TickQueue.surfaceCounts()[0], 0);
    TickQueue.enqueue({ "uuid" => "b-own" }, second);
    client = new CapturedBsClient();
    var observer = new FlushCompletionObserver();
    new TickFlusher(client).start(observer.method(:done));
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(client.sent[0]["params"]["variables"]["input"]["uuid"], "b-own");
    client.sent[0]["callback"].invoke(200, savedReply("b-own"));
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(observer.calls, 1);
    Test.assertEqual(RejectedTicks.countFor(TickQueue.loadRejected(), "owner-a"), 1);

    installAuthFixture("owner-a", 2820);
    client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(client.sent[0]["params"]["variables"]["input"]["uuid"], "a-queued");
    client.sent[0]["callback"].invoke(200, savedReply("a-queued"));
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(TickQueue.surfaceCounts()[0], 1);
    resetTickStores();
    return true;
}
