using Toybox.Test;
using Toybox.Lang;

(:debug)
function sessionsAuthRejected() as Lang.Dictionary {
    return {
        "data" => null,
        "errors" => [{
            "message" => "Authentication required",
            "path" => ["authenticatedUserId"],
            "extensions" => { "code" => "UNAUTHENTICATED" }
        }]
    };
}

(:test)
function testSessionDiscoveryRefreshesAnExpiredBearerBeforeShowingSessions(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 510);
    var observer = new RequestResultObserver();
    var client = new CapturedBsClient();
    client.fetchMySessions(observer.method(:onResult));
    Test.assertEqual(client.sent[0]["params"]["query"],
        "query { authenticatedUserId mySessions { id name boardPath isActive } }");
    client.sent[0]["callback"].invoke(200, sessionsAuthRejected());
    Test.assertEqual(observer.calls, 0);
    Test.assertEqual(client.sent.size(), 2);
    Test.assertEqual(client.sent[1]["params"]["refreshToken"], "refresh");
    var rotated = authResponse("owner-a");
    rotated["jwt"] = "new-access";
    client.sent[1]["callback"].invoke(200, rotated);
    Test.assertEqual(client.sent.size(), 3);
    Test.assertEqual(client.sent[2]["token"], "new-access");
    var sessions = [{ "id" => "session-one", "name" => "Evening", "boardPath" => "/kilter", "isActive" => true }];
    client.sent[2]["callback"].invoke(200,
        { "data" => { "authenticatedUserId" => "owner-a", "mySessions" => sessions } });
    Test.assertEqual(observer.calls, 1);
    Test.assertEqual(observer.result[0]["id"], "session-one");
    Test.assertEqual(client.lost, 0);
    return true;
}

(:test)
function testSessionDiscoveryDoesNotRefreshAnHonestEmptyList(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 520);
    var observer = new RequestResultObserver();
    var client = new CapturedBsClient();
    client.fetchMySessions(observer.method(:onResult));
    client.sent[0]["callback"].invoke(200,
        { "data" => { "authenticatedUserId" => "owner-a", "mySessions" => [] } });
    Test.assertEqual(client.sent.size(), 1);
    Test.assertEqual(observer.calls, 1);
    Test.assertEqual(observer.result.size(), 0);
    Test.assertEqual(AuthState.statusIs(TokenStore.snapshot(), "active"), true);
    return true;
}

(:test)
function testConcurrentSessionDiscoverySharesOneRotationAndRetriesOnce(logger as Test.Logger) as Lang.Boolean {
    installAuthFixture("owner-a", 530);
    var first = new RequestResultObserver();
    var second = new RequestResultObserver();
    var client = new CapturedBsClient();
    client.fetchMySessions(first.method(:onResult));
    client.fetchMySessions(second.method(:onResult));
    client.sent[0]["callback"].invoke(200, sessionsAuthRejected());
    client.sent[1]["callback"].invoke(200, sessionsAuthRejected());
    Test.assertEqual(client.sent.size(), 3);
    var rotated = authResponse("owner-a");
    rotated["jwt"] = "new-access";
    client.sent[2]["callback"].invoke(200, rotated);
    Test.assertEqual(client.sent.size(), 5);
    client.sent[3]["callback"].invoke(200, sessionsAuthRejected());
    client.sent[4]["callback"].invoke(200, sessionsAuthRejected());
    Test.assertEqual(client.sent.size(), 5);
    Test.assertEqual(first.calls, 1);
    Test.assertEqual(second.calls, 1);
    Test.assertEqual(first.result, null);
    Test.assertEqual(second.result, null);
    return true;
}

(:test)
function testSessionDiscoveryRequiresTheIdentityRefusal(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(BsAuthReply.graphqlSessionsAuthRequired(200, sessionsAuthRejected()), true);
    Test.assertEqual(BsAuthReply.graphqlSessionsAuthRequired(503, sessionsAuthRejected()), false);
    Test.assertEqual(BsAuthReply.graphqlSessionsAuthRequired(200,
        { "data" => { "mySessions" => [] } }), false);
    var refusal = sessionsAuthRejected();
    refusal["errors"][0]["path"] = ["mySessions"];
    Test.assertEqual(BsAuthReply.graphqlSessionsAuthRequired(200, refusal), false);
    refusal = sessionsAuthRejected();
    refusal["errors"][0]["extensions"]["code"] = "SERVICE_UNAVAILABLE";
    Test.assertEqual(BsAuthReply.graphqlSessionsAuthRequired(200, refusal), false);
    refusal = sessionsAuthRejected();
    refusal["errors"][0]["message"] = "Authentication is temporarily unavailable";
    Test.assertEqual(BsAuthReply.graphqlSessionsAuthRequired(200, refusal), false);
    return true;
}
