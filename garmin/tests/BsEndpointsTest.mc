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
    var input = BsEndpoints.saveTickInput(sampleState(), "sess-1", "flash", 1, "2026-07-05T12:00:00Z");

    // Copied straight from state / climb.
    Test.assertEqual(input["boardType"], "kilter");
    Test.assertEqual(input["climbUuid"], "abc-123");
    Test.assertEqual(input["layoutId"], 8);
    Test.assertEqual(input["sizeId"], 22);
    Test.assertEqual(input["setIds"], "26,27");
    Test.assertEqual(input["sessionId"], "sess-1");

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
    var input = BsEndpoints.saveTickInput(sampleState(), "sess-1", "attempt", 1, "2026-07-05T12:00:00Z");
    Test.assertEqual(input["status"], "attempt");
    Test.assertEqual(input["attemptCount"], 1);
    return true;
}
