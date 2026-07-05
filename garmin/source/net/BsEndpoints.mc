using Toybox.Lang;

// Pure URL + request-body builders for the Boardsesh backend contract.
//
// NO I/O lives here on purpose: everything is a pure function of its inputs so
// it can be unit-tested without a network or the simulator (see tests/).
// BsClient is the only place that actually performs requests.
module BsEndpoints {

    // ---- URLs ---------------------------------------------------------------

    function pairUrl(base as Lang.String) as Lang.String {
        return base + "/api/watch/pair";
    }

    function refreshUrl(base as Lang.String) as Lang.String {
        return base + "/auth/native/refresh";
    }

    // GET. The sessionId is carried in the query string; BsClient sends empty
    // query params so this URL is used verbatim.
    function stateUrl(base as Lang.String, sessionId as Lang.String) as Lang.String {
        return base + "/api/session/state?sessionId=" + sessionId;
    }

    function navigateUrl(base as Lang.String) as Lang.String {
        return base + "/api/session/navigate";
    }

    function takeControlUrl(base as Lang.String) as Lang.String {
        return base + "/api/session/take-control";
    }

    function graphqlUrl(base as Lang.String) as Lang.String {
        return base + "/graphql";
    }

    // ---- REST bodies --------------------------------------------------------

    function pairBody(code as Lang.String) as Lang.Dictionary {
        return { "code" => code };
    }

    function refreshBody(refreshToken as Lang.String) as Lang.Dictionary {
        return { "refreshToken" => refreshToken };
    }

    function navigateBody(sessionId as Lang.String, action as Lang.String) as Lang.Dictionary {
        return { "sessionId" => sessionId, "action" => action };
    }

    function takeControlBody(sessionId as Lang.String) as Lang.Dictionary {
        return { "sessionId" => sessionId };
    }

    // ---- GraphQL bodies -----------------------------------------------------

    // query { mySessions { id name boardPath isActive } }
    function mySessionsBody() as Lang.Dictionary {
        return {
            "query" => "query { mySessions { id name boardPath isActive } }",
            "variables" => {}
        };
    }

    // mutation SaveTick($input: SaveTickInput!) { saveTick(input: $input) { uuid } }
    function saveTickGraphqlBody(input as Lang.Dictionary) as Lang.Dictionary {
        return {
            "query" => "mutation SaveTick($input: SaveTickInput!) { saveTick(input: $input) { uuid } }",
            "variables" => { "input" => input }
        };
    }

    // ---- SaveTickInput ------------------------------------------------------

    // Build the SaveTickInput dictionary purely from a slim /api/session/state
    // payload plus the sessionId and the chosen status.
    //
    // `state` is the parsed slim state dict:
    //   { boardType, layoutId, sizeId, setIds, angle, currentIndex, queueLength,
    //     climb: { climbUuid, name, difficulty, angle, mirrored, isBenchmark } }
    //
    // status is "attempt" | "send" | "flash"; attemptCount is caller-computed
    // (flash => 1); climbedAtIso is captured at log time by the caller.
    function saveTickInput(
        state as Lang.Dictionary,
        sessionId as Lang.String,
        status as Lang.String,
        attemptCount as Lang.Number,
        climbedAtIso as Lang.String
    ) as Lang.Dictionary {
        var climb = state["climb"];

        // VERIFY: which "angle" the tick should record. We use the top-level
        // session/board angle (state["angle"]), matching the backend contract
        // note that angle "comes straight from state". climb["angle"] is the
        // climb's native angle and is intentionally NOT used here. Confirm the
        // backend expects the board angle on saveTick.
        return {
            "boardType"    => state["boardType"],
            "climbUuid"    => climb["climbUuid"],
            "angle"        => state["angle"],
            "isMirror"     => climb["mirrored"],
            "status"       => status,
            "attemptCount" => attemptCount,
            "quality"      => null,
            "difficulty"   => null,
            "isBenchmark"  => climb["isBenchmark"],
            "comment"      => "",
            "climbedAt"    => climbedAtIso,
            "sessionId"    => sessionId,
            "layoutId"     => state["layoutId"],
            "sizeId"       => state["sizeId"],
            "setIds"       => state["setIds"]
        };
    }
}
