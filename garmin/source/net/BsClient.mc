using Toybox.Communications;
using Toybox.Lang;

// HTTP client for the Boardsesh backend.
//
// Every authed request goes through a BsRequest, which:
//   * attaches the Bearer JWT from TokenStore,
//   * on a 401 triggers a single-flight token refresh and retries ONCE,
//   * on refresh failure clears tokens and fires onAuthLost (route to pairing).
//
// GraphQL calls POST { query, variables } to /graphql and the caller callback
// receives the already-unwrapped data.<field> value (or null).
//
// Every public method takes a callback Method invoked as cb.invoke(code, data).
class BsClient {
    private var _base as Lang.String;
    private var _onAuthLost;                 // Method() invoked when refresh fails
    private var _refreshing as Lang.Boolean; // single-flight refresh guard
    private var _retryQueue as Lang.Array;   // BsRequest awaiting refresh

    function initialize(baseUrl as Lang.String, onAuthLost) {
        _base = baseUrl;
        _onAuthLost = onAuthLost;
        _refreshing = false;
        _retryQueue = [];
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

    // Standalone refresh (stores the rotated triple on success). The withAuth
    // retry path uses its own internal refresh (see _handleUnauthorized).
    function refresh(cb) as Void {
        var token = TokenStore.refreshToken();
        if (token == null) {
            cb.invoke(401, null);
            return;
        }
        var request = new BsRequest(
            self,
            BsEndpoints.refreshUrl(_base),
            BsEndpoints.refreshBody(token),
            Communications.HTTP_REQUEST_METHOD_POST,
            false,
            null,
            new StoringRefreshCb(cb)
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

    // The raw transport used by BsRequest. Kept here so header/JSON options live
    // in one place.
    function sendRaw(url as Lang.String, params, httpMethod as Lang.Number, authed as Lang.Boolean, callback) as Void {
        var headers = {
            // Communications.REQUEST_CONTENT_TYPE_JSON is the canonical constant
            // for the "application/json" request content type; makeWebRequest
            // JSON-encodes the Dictionary `params` body when it's set. (Confirmed
            // correct — do not swap for a raw string.)
            "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON
        };
        if (authed) {
            var token = TokenStore.jwt();
            if (token != null) {
                headers["Authorization"] = "Bearer " + token;
            }
        }
        var options = {
            :method => httpMethod,
            :headers => headers,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
        };
        Communications.makeWebRequest(url, params, options, callback);
    }

    // Called by a BsRequest that saw a 401. Queues it and kicks a single-flight
    // refresh; concurrent 401s piggyback on the one in-flight refresh.
    function handleUnauthorized(request as BsRequest) as Void {
        _retryQueue.add(request);
        if (_refreshing) {
            return;
        }
        _refreshing = true;

        var refreshTok = TokenStore.refreshToken();
        if (refreshTok == null) {
            _onRefreshFailed();
            return;
        }
        sendRaw(
            BsEndpoints.refreshUrl(_base),
            BsEndpoints.refreshBody(refreshTok),
            Communications.HTTP_REQUEST_METHOD_POST,
            false,
            method(:_onRefreshResponse)
        );
    }

    function _onRefreshResponse(code as Lang.Number, data) as Void {
        _refreshing = false;
        if (code >= 200 && code < 300 && data != null && data["jwt"] != null) {
            // Persist the rotated triple BEFORE retrying anything (single-use).
            TokenStore.store(data["jwt"], data["refreshToken"], data["expiresAt"]);
            var queued = _retryQueue;
            _retryQueue = [];
            for (var i = 0; i < queued.size(); i += 1) {
                queued[i].fire();   // retry with the new token
            }
        } else {
            _onRefreshFailed();
        }
    }

    function _onRefreshFailed() as Void {
        _refreshing = false;
        var queued = _retryQueue;
        _retryQueue = [];
        for (var i = 0; i < queued.size(); i += 1) {
            queued[i].fail(401);
        }
        TokenStore.clear();
        if (_onAuthLost != null) {
            _onAuthLost.invoke();
        }
    }
}

// A single web request that knows how to unwrap GraphQL and retry once on 401.
class BsRequest {
    private var _client as BsClient;
    private var _url as Lang.String;
    private var _params;
    private var _httpMethod as Lang.Number;
    private var _authed as Lang.Boolean;
    private var _unwrapField;   // Lang.String or Null (graphql data.<field>)
    private var _cb;            // caller Method(code, data)
    private var _retried as Lang.Boolean;

    function initialize(client, url, params, httpMethod, authed, unwrapField, cb) {
        _client = client;
        _url = url;
        _params = params;
        _httpMethod = httpMethod;
        _authed = authed;
        _unwrapField = unwrapField;
        _cb = cb;
        _retried = false;
    }

    function fire() as Void {
        _client.sendRaw(_url, _params, _httpMethod, _authed, method(:onResponse));
    }

    function onResponse(code as Lang.Number, data) as Void {
        if (code == 401 && _authed && !_retried) {
            _retried = true;
            _client.handleUnauthorized(self);   // refresh, then re-fire()
            return;
        }
        _cb.invoke(code, _unwrap(data));
    }

    // Invoked by the client when a refresh definitively failed.
    function fail(code as Lang.Number) as Void {
        _cb.invoke(code, null);
    }

    private function _unwrap(data) {
        if (_unwrapField == null) {
            return data;
        }
        // GraphQL: read data.data.<field>. On GraphQL errors data.data is null.
        if (data != null && data.hasKey("data")) {
            var gqlData = data["data"];
            if (gqlData != null) {
                return gqlData[_unwrapField];
            }
        }
        return null;
    }
}

// Adapter that stores the rotated token triple returned by a standalone
// refresh() before handing the raw payload to the caller.
class StoringRefreshCb {
    private var _cb;
    function initialize(cb) { _cb = cb; }
    function invoke(code as Lang.Number, data) as Void {
        if (code >= 200 && code < 300 && data != null && data["jwt"] != null) {
            TokenStore.store(data["jwt"], data["refreshToken"], data["expiresAt"]);
        }
        _cb.invoke(code, data);
    }
}
