using Toybox.Communications;
using Toybox.Lang;
using Toybox.System;

// HTTP client for the Boardsesh backend.
//
// Every authed request goes through a BsRequest, which:
//   * captures a Bearer JWT and login scope at request creation,
//   * on a 401 triggers a single-flight token refresh and retries ONCE,
//   * requires explicit pairing after a failed/ambiguous single-use rotation.
//
// GraphQL calls POST { query, variables } to /graphql and the caller callback
// receives the already-unwrapped data.<field> value (or null).
//
// Callbacks receive (code, payload, capturedOrigin); stale results settle only
// their own lease/flight and never apply state to another login.
class BsClient {
    private var _base as Lang.String;
    private var _onAuthLost;                 // Method() invoked when refresh fails
    private var _flight = null;

    function initialize(baseUrl as Lang.String, onAuthLost) {
        _base = baseUrl;
        _onAuthLost = onAuthLost;
    }

    function baseUrl() as Lang.String {
        return _base;
    }

    // ---- Public API ---------------------------------------------------------

    // Unauthed: exchange an 8-char pairing code for a token triple.
    function pair(code as Lang.String, cb) as Void {
        var request = new BsRequest(
            self,
            BsEndpoints.pairUrl(_base),
            BsEndpoints.pairBody(code),
            Communications.HTTP_REQUEST_METHOD_POST,
            false,   // not authed
            null,    // no graphql unwrap
            cb
        );
        request.fire();
    }

    function fetchMySessions(cb) as Void {
        _graphql(BsEndpoints.mySessionsBody(), "mySessions", cb);
    }

    function fetchState(sessionId as Lang.String, cb) as Void {
        var request = new BsRequest(
            self,
            BsEndpoints.stateUrl(_base, sessionId),
            {},   // empty GET params; sessionId is in the URL
            Communications.HTTP_REQUEST_METHOD_GET,
            true,
            null,
            cb
        );
        request.fire();
    }

    function navigate(sessionId as Lang.String, action as Lang.String, cb) as Void {
        _post(BsEndpoints.navigateUrl(_base), BsEndpoints.navigateBody(sessionId, action), cb);
    }

    function takeControl(sessionId as Lang.String, cb) as Void {
        _post(BsEndpoints.takeControlUrl(_base), BsEndpoints.takeControlBody(sessionId), cb);
    }

    function saveTick(input as Lang.Dictionary, cb) as Void {
        _graphql(BsEndpoints.saveTickGraphqlBody(input), "saveTick", cb);
    }

    // ---- Internal helpers ---------------------------------------------------

    private function _post(url as Lang.String, body as Lang.Dictionary, cb) as Void {
        var request = new BsRequest(
            self, url, body, Communications.HTTP_REQUEST_METHOD_POST, true, null, cb
        );
        request.fire();
    }

    private function _graphql(body as Lang.Dictionary, field as Lang.String, cb) as Void {
        var request = new BsRequest(
            self,
            BsEndpoints.graphqlUrl(_base),
            body,
            Communications.HTTP_REQUEST_METHOD_POST,
            true,
            field,   // unwrap data.<field>
            cb
        );
        request.fire();
    }

    // A request supplies its captured token. This transport NEVER reads a
    // globally current JWT (an old A request must never acquire B credentials).
    function sendRaw(url as Lang.String, params, httpMethod as Lang.Number, token, callback) as Void {
        var headers = { "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON };
        if (token instanceof Lang.String) { headers["Authorization"] = "Bearer " + token; }
        var options = { :method => httpMethod as Communications.HttpRequestMethod,
            :headers => headers, :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON };
        try { Communications.makeWebRequest(url, params, options, callback); }
        catch (exception) { callback.invoke(-1, null); }
    }

    function handleUnauthorized(request as BsRequest) as Void {
        var captured = request.context();
        if (!TokenStore.current(captured)) { request.fail(BsResponse.STALE); return; }
        // An already completed same-scope rotation can satisfy a delayed 401.
        var latest = TokenStore.snapshot();
        if (latest != null && AuthState.statusIs(latest, "active") &&
                latest["revision"] != captured["revision"]) {
            request.retryWith(latest);
            return;
        }
        if (_flight != null && _flight.accepts(captured)) {
            _flight.add(request);
            return;
        }
        var pending = TokenStore.beginRotation(latest);
        if (pending == null) {
            request.fail(401);
            // A restarted/ambiguous flight may keep its old access JWT and
            // owned offline logs. Once that JWT is rejected, explicit pairing
            // is required; never submit the old refresh secret again.
            if (TokenStore.currentRevision(latest) && AuthState.statusIs(latest, "rotating")) {
                TokenStore.clear();
                _authLost();
            }
            return;
        }
        var flight = new BsRefreshFlight(self, pending);
        _flight = flight;
        flight.add(request);
        flight.start();
    }

    function refreshFinished(flight, pending, code as Lang.Number, response) as Void {
        // A stale flight owns only its queue. It cannot touch the newer flight,
        // credentials, auth-loss routing or state belonging to another login.
        if (!TokenStore.currentRevision(pending)) {
            flight.finish(BsResponse.STALE, null);
            return;
        }
        if (_flight == flight) { _flight = null; }
        if (code >= 200 && code < 300 && TokenStore.acceptRotation(pending, response)) {
            flight.finish(code, TokenStore.snapshot());
            return;
        }
        if (BsRefreshPolicy.provenUnconsumed(code, response)) {
            var resumed = AuthState.resumeUnconsumed(pending);
            if (TokenStore.replace(pending, resumed)) {
                flight.finish(code, null);
                return;
            }
            // Failed persistence cannot authorize retry of a single-use secret.
        }
        var definitive = code >= 400 && code < 500 && code != 429;
        var unusableSuccess = code >= 200 && code < 300;
        flight.finish(unusableSuccess ? 401 : code, null);
        if (definitive || unusableSuccess || pending["owner"] == null) {
            if (TokenStore.currentRevision(pending)) {
                TokenStore.clear();
                _authLost();
            }
        }
        // Lost responses/timeouts are ambiguous: keep the durable marker so
        // refresh is never retried. Known-owner access JWTs and owned offline
        // logs remain usable until a genuine access rejection needs pairing.
    }

    private function _authLost() as Void {
        if (Services.activity != null && Services.activity.isRecording()) { Services.activity.stopAndSave(); }
        AppState.attachSession(null, null);
        AppState.authContext = null;
        SessionLog.reset();
        if (_onAuthLost != null) { _onAuthLost.invoke(); }
    }
}

module BsRefreshPolicy {
    function provenUnconsumed(code as Lang.Number, response) as Lang.Boolean {
        // SDK distinguishes no connection/queue refusal from response timeout
        // or dropped connection. Only these pre-send results permit RT reuse.
        if (code == Communications.BLE_CONNECTION_UNAVAILABLE || code == Communications.BLE_QUEUE_FULL) { return true; }
        if (!(response instanceof Lang.Dictionary) || !(response["error"] instanceof Lang.String)) { return false; }
        var message = response["error"];
        // Existing refresh endpoint paths: overload precedes the transaction;
        // admission unavailable escapes the transaction, so its writes rollback.
        if (code == 503 && (message.equals("Service temporarily overloaded") ||
                message.equals("Authentication is temporarily unavailable"))) { return true; }
        var prefix = "Rate limit exceeded. Try again in ";
        return code == 429 && message.length() >= prefix.length() && message.substring(0, prefix.length()).equals(prefix);
    }
}

class BsRefreshFlight {
    private var _client;
    private var _pending;
    private var _queue as Lang.Array;
    private var _settled = false;

    function initialize(client, pending) { _client = client; _pending = pending; _queue = []; }
    function accepts(captured) as Lang.Boolean { return !_settled && AuthState.sameScope(captured, _pending); }
    function add(request) as Void { _queue.add(request); }
    function start() as Void {
        _client.sendRaw(BsEndpoints.refreshUrl(_client.baseUrl()), BsEndpoints.refreshBody(_pending["refresh"]),
            Communications.HTTP_REQUEST_METHOD_POST, null, method(:onResponse));
    }
    function onResponse(code as Lang.Number, response) as Void {
        if (_settled) { return; }
        _client.refreshFinished(self, _pending, code, response);
    }
    function finish(code as Lang.Number, replacement) as Void {
        if (_settled) { return; }
        _settled = true;
        var queued = _queue;
        _queue = [];
        for (var index = 0; index < queued.size(); index += 1) {
            if (replacement != null) { queued[index].retryWith(replacement); }
            else { queued[index].fail(code); }
        }
    }
}

module BsResponse { const STALE = -32001; }

class BsRequest {
    private var _client;
    private var _url;
    private var _params;
    private var _httpMethod;
    private var _authed;
    private var _unwrapField;
    private var _cb;
    private var _captured;
    private var _retried = false;
    private var _settled = false;

    function initialize(client, url, params, httpMethod, authed, unwrapField, cb) {
        _client = client; _url = url; _params = params; _httpMethod = httpMethod;
        _authed = authed; _unwrapField = unwrapField; _cb = cb;
        _captured = TokenStore.snapshot();
    }
    function context() { return _captured; }
    function fire() as Void {
        if (_settled) { return; }
        if (!TokenStore.current(_captured)) { fail(BsResponse.STALE); return; }
        if (_authed && !AuthState.canUseAccess(_captured)) {
            if (!_retried && AuthState.statusIs(_captured, "bootstrap")) {
                _retried = true;
                _client.handleUnauthorized(self);
            } else { fail(401); }
            return;
        }
        _client.sendRaw(_url, _params, _httpMethod, _authed ? _captured["jwt"] : null, method(:onResponse));
    }
    function retryWith(replacement) as Void {
        // A first verified bootstrap legitimately moves to a NEW scope. It may
        // complete its original read, but never resurrect quarantined ticks.
        if (!TokenStore.current(replacement) || !AuthState.statusIs(replacement, "active") ||
                (_captured["owner"] != null && !AuthState.sameScope(_captured, replacement)) ||
                (_captured["owner"] == null && replacement["scope"] != _captured["scope"] + 1)) {
            fail(BsResponse.STALE); return;
        }
        _captured = replacement;
        _retried = true;
        fire();
    }
    function onResponse(code as Lang.Number, response) as Void {
        if (_settled) { return; }
        if (!TokenStore.current(_captured)) { fail(BsResponse.STALE); return; }
        if (code == 401 && _authed && !_retried) {
            _retried = true;
            _client.handleUnauthorized(self);
            return;
        }
        _settled = true;
        _cb.invoke(code, _unwrap(response), _captured);
    }
    function fail(code as Lang.Number) as Void {
        if (_settled) { return; }
        _settled = true;
        _cb.invoke(code, null, _captured);
    }
    private function _unwrap(response) {
        if (_unwrapField == null) { return response; }
        if (!(response instanceof Lang.Dictionary) || response.hasKey("errors")) { return null; }
        var fields = response["data"];
        return fields instanceof Lang.Dictionary ? fields[_unwrapField] : null;
    }
}
