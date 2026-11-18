using Toybox.Test;
using Toybox.Lang;

// Pure-logic tests for BsEndpoints. No I/O, so they run in the unit-test harness
// without the simulator UI or a network.
//
// Run: build with -t, then `monkeydo bin/boardsesh.prg fenix7 -t` (see README).

(:test)
function testStateUrl(logger as Test.Logger) as Lang.Boolean {
    var url = BsEndpoints.stateUrl("https://ws.boardsesh.com", "s1");
    Test.assertEqual(url, "https://ws.boardsesh.com/api/session/state?sessionId=s1");
    return true;
}

(:test)
function testSimpleUrls(logger as Test.Logger) as Lang.Boolean {
    var base = "https://ws.boardsesh.com";
    Test.assertEqual(BsEndpoints.pairUrl(base), base + "/api/watch/pair");
    Test.assertEqual(BsEndpoints.refreshUrl(base), base + "/auth/native/refresh");
    Test.assertEqual(BsEndpoints.navigateUrl(base), base + "/api/session/navigate");
    Test.assertEqual(BsEndpoints.takeControlUrl(base), base + "/api/session/take-control");
    Test.assertEqual(BsEndpoints.graphqlUrl(base), base + "/graphql");
    return true;
}

(:test)
function testNavigateBody(logger as Test.Logger) as Lang.Boolean {
    var body = BsEndpoints.navigateBody("s1", "next");
    Test.assertEqual(body["sessionId"], "s1");
    Test.assertEqual(body["action"], "next");
    return true;
}

(:test)
function testPairAndRefreshBodies(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(BsEndpoints.pairBody("ABCD1234")["code"], "ABCD1234");
    Test.assertEqual(BsEndpoints.refreshBody("rtok")["refreshToken"], "rtok");
    Test.assertEqual(BsEndpoints.takeControlBody("s1")["sessionId"], "s1");
    return true;
}

(:test)
function testGraphqlBodies(logger as Test.Logger) as Lang.Boolean {
    var my = BsEndpoints.mySessionsBody();
    Test.assertEqual(my["query"], "query { mySessions { id name boardPath isActive } }");

    var tick = BsEndpoints.saveTickGraphqlBody({ "climbUuid" => "abc" });
    Test.assertEqual(
        tick["query"],
        "mutation SaveTick($input: SaveTickInput!) { saveTick(input: $input) { uuid } }"
    );
    Test.assertEqual(tick["variables"]["input"]["climbUuid"], "abc");
    return true;
}

// (:debug) so this helper compiles into unit-test/debug builds (where the
// (:test) callers live) but is stripped from release builds. It is NOT (:test)
// itself — the harness must not try to run it as a test.
(:debug)
function sampleState() as Lang.Dictionary {
    return {
        "boardType"    => "kilter",
        "layoutId"     => 8,
        "sizeId"       => 22,
        "setIds"       => "26,27",
        "angle"        => 40,
        "currentIndex" => 2,
        "queueLength"  => 5,
        "sequence"     => 12,
        "climb"        => {
            "climbUuid"   => "abc-123",
            "name"        => "Test Problem",
            "difficulty"  => "V4",
            "angle"       => 45,      // climb native angle: must NOT be used
            "mirrored"    => true,
            "isBenchmark" => false
        }
    };
}

(:test)
function testSaveTickInputFlashMapping(logger as Test.Logger) as Lang.Boolean {
    var input = BsEndpoints.saveTickInput(sampleState(), "sess-1", "flash", 1,
        "2026-07-05T12:00:00Z", "123e4567-e89b-42d3-a456-426614174000");

    // Copied straight from state / climb.
    Test.assertEqual(input["boardType"], "kilter");
    Test.assertEqual(input["climbUuid"], "abc-123");
    Test.assertEqual(input["layoutId"], 8);
    Test.assertEqual(input["sizeId"], 22);
    Test.assertEqual(input["setIds"], "26,27");
    Test.assertEqual(input["sessionId"], "sess-1");
    Test.assertEqual(input["uuid"], "123e4567-e89b-42d3-a456-426614174000");

    // angle comes from the session/board angle (state.angle == 40), not the
    // climb's native angle (45).
    Test.assertEqual(input["angle"], 40);

    // isMirror mirrors climb.mirrored.
    Test.assertEqual(input["isMirror"], true);
    Test.assertEqual(input["isBenchmark"], false);

    // status + attemptCount for a flash.
    Test.assertEqual(input["status"], "flash");
    Test.assertEqual(input["attemptCount"], 1);

    // Fixed / nulled fields.
    Test.assert(input["quality"] == null);
    Test.assert(input["difficulty"] == null);
    Test.assertEqual(input["comment"], "");
    Test.assertEqual(input["climbedAt"], "2026-07-05T12:00:00Z");
    return true;
}

(:test)
function testSaveTickInputAttempt(logger as Test.Logger) as Lang.Boolean {
    var input = BsEndpoints.saveTickInput(sampleState(), "sess-1", "attempt", 1,
        "2026-07-05T12:00:00Z", "123e4567-e89b-42d3-a456-426614174001");
    Test.assertEqual(input["status"], "attempt");
    Test.assertEqual(input["attemptCount"], 1);
    return true;
}

(:test)
function testSaveTickInputPassesAttemptCountThrough(logger as Test.Logger) as Lang.Boolean {
    // The builder is generic: it forwards whatever attemptCount the caller passes.
    // (ClimbDelegate currently always sends 1 — one tick per logged effort — but
    // the builder must not hardcode it.)
    var input = BsEndpoints.saveTickInput(sampleState(), "sess-1", "send", 4,
        "2026-07-05T12:00:00Z", "123e4567-e89b-42d3-a456-426614174002");
    Test.assertEqual(input["status"], "send");
    Test.assertEqual(input["attemptCount"], 4);
    return true;
}

(:test)
function testSaveTickInputCarriesTheBoardUuidOnlyWhenStateHasOne(logger as Test.Logger) as Lang.Boolean {
    // Every server today: no boardUuid in state, no key in the body (the
    // input schema refuses a null one).
    var plain = BsEndpoints.saveTickInput(sampleState(), "sess-1", "send", 1,
        "2026-07-05T12:00:00Z", "123e4567-e89b-42d3-a456-426614174003");
    Test.assertEqual(plain.hasKey("boardUuid"), false);

    var state = sampleState();
    state["boardUuid"] = "0b5a8f0e-6a2d-4f43-9d1e-2b7c3e8f9a10";
    var withBoard = BsEndpoints.saveTickInput(state, "sess-1", "send", 1,
        "2026-07-05T12:00:00Z", "123e4567-e89b-42d3-a456-426614174004");
    Test.assertEqual(withBoard["boardUuid"], "0b5a8f0e-6a2d-4f43-9d1e-2b7c3e8f9a10");

    var malformed = [null, "", "not-a-uuid", 42, ["0b5a8f0e-6a2d-4f43-9d1e-2b7c3e8f9a10"]];
    for (var index = 0; index < malformed.size(); index += 1) {
        state["boardUuid"] = malformed[index];
        var input = BsEndpoints.saveTickInput(state, "sess-1", "send", 1,
            "2026-07-05T12:00:00Z", "123e4567-e89b-42d3-a456-426614174005");
        Test.assertEqual(input.hasKey("boardUuid"), false);
    }
    return true;
}

// A tick queued with a board uuid keeps it through the outbox and is sent
// with it, unchanged, on the drain.
(:test)
function testQueuedTickSendsItsBoardUuid(logger as Test.Logger) as Lang.Boolean {
    var context = installAuthFixture("owner-a", 3100);
    resetTickStores();
    var state = sampleState();
    state["boardUuid"] = "0b5a8f0e-6a2d-4f43-9d1e-2b7c3e8f9a10";
    Test.assert(TickQueue.enqueue(BsEndpoints.saveTickInput(state, "sess-1", "send", 1,
        "2026-07-05T12:00:00Z", "123e4567-e89b-42d3-a456-426614174006"), context));
    var client = new CapturedBsClient();
    new TickFlusher(client).start(new FlushCompletionObserver().method(:done));
    Test.assertEqual(client.sent[0]["params"]["variables"]["input"]["boardUuid"],
        "0b5a8f0e-6a2d-4f43-9d1e-2b7c3e8f9a10");
    client.sent[0]["callback"].invoke(200, savedReply("123e4567-e89b-42d3-a456-426614174006"));
    Test.assertEqual(TickQueue.size(), 0);
    resetTickStores();
    return true;
}

(:test)
function testUuidV4Formatting(logger as Test.Logger) as Lang.Boolean {
    var formatted = Uuid.formatV4([
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xf6, 0x07,
        0x48, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
    ]);
    Test.assertEqual(formatted, "00010203-0405-4607-8809-0a0b0c0d0e0f");
    Test.assertEqual(formatted.length(), 36);
    return true;
}
