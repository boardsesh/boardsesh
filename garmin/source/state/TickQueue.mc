using Toybox.Lang;

// Owner-partitioned durable outbox plus its dead-letter store.
// Capacity and storage failure refuse new logs; no queued effort is evicted.
module TickQueue {
    const KEY = "bs.pendingTicks";
    const REJECTED_KEY = "bs.rejectedTicks";

    // ---- saveTick replies (pure) -------------------------------------------
    //
    // Derived from the saveTick resolver (packages/backend/src/graphql/
    // resolvers/ticks/mutations.ts) behind graphql-yoga's /graphql transport.
    //
    //   acknowledged  2xx, no `errors`, data.saveTick.uuid is the sent UUID.
    //                 A UUID this account already saved answers the stored tick.
    //   rejected      400: yoga refused the variables (unknown field, null for
    //                 a required field, unknown enum value) or the body.
    //                 2xx with only these errors: CLIMB_NOT_FOUND (spray climb
    //                 gone or hidden), TICK_UUID_CONFLICT (another account owns
    //                 this UUID), GRAPHQL_VALIDATION_FAILED, or the code-less
    //                 "Invalid input: ..." that SaveTickInputSchema throws.
    //   retry         everything else: SDK transport codes (< 0), 401 after the
    //                 client's own refresh, edge 404/429/5xx, masked
    //                 INTERNAL_SERVER_ERROR, SERVICE_UNAVAILABLE, UNAUTHENTICATED,
    //                 the code-less "Authentication required ..." an expired
    //                 token receives, and any reply shape not listed above.

    function savedUuid(code as Lang.Number, response) {
        if (code < 200 || code >= 300 || !(response instanceof Lang.Dictionary) || response["errors"] != null) {
            return null;
        }
        var fields = response["data"];
        if (!(fields instanceof Lang.Dictionary)) { return null; }
        var saved = fields["saveTick"];
        if (!(saved instanceof Lang.Dictionary)) { return null; }
        var savedUuidValue = saved["uuid"];
        return savedUuidValue instanceof Lang.String ? savedUuidValue : null;
    }

    function exactAck(code as Lang.Number, response, uuid) as Lang.Boolean {
        var saved = savedUuid(code, response);
        return uuid instanceof Lang.String && saved != null && saved.equals(uuid);
    }

    // The permanent reason one GraphQL error carries, or null to retry.
    function errorReason(error) {
        if (!(error instanceof Lang.Dictionary)) { return null; }
        var extensions = error["extensions"];
        var errorCode = extensions instanceof Lang.Dictionary ? extensions["code"] : null;
        if (errorCode instanceof Lang.String) {
            if (errorCode.equals("CLIMB_NOT_FOUND") || errorCode.equals("TICK_UUID_CONFLICT") ||
                    errorCode.equals("GRAPHQL_VALIDATION_FAILED")) {
                return errorCode;
            }
            return null;
        }
        if (errorCode != null) { return null; }
        var message = error["message"];
        var prefix = "Invalid input: ";
        if (message instanceof Lang.String && message.length() >= prefix.length() &&
                message.substring(0, prefix.length()).equals(prefix)) {
            return "INVALID_INPUT";
        }
        return null;
    }

    // Null unless the server positively refused this exact tick for good.
    // Every error in the reply must be a permanent one; one unknown or
    // retryable error makes the whole reply a retry.
    function rejectionReason(code as Lang.Number, response) {
        if (code == 400) { return "HTTP_400"; }
        if (code < 200 || code >= 300 || !(response instanceof Lang.Dictionary)) { return null; }
        var errors = response["errors"];
        if (!(errors instanceof Lang.Array) || errors.size() == 0) { return null; }
        var reason = null;
        for (var index = 0; index < errors.size(); index += 1) {
            var errorVerdict = errorReason(errors[index]);
            if (errorVerdict == null) { return null; }
            if (reason == null) { reason = errorVerdict; }
        }
        return reason;
    }

    function classifyFlushResult(code as Lang.Number, response, uuid) as Lang.Symbol {
        if (exactAck(code, response, uuid)) { return :success; }
        return rejectionReason(code, response) != null ? :rejected : :retry;
    }

    // ---- storage adapters --------------------------------------------------

    function loadEnvelope() {
        try { return OwnedTickOutbox.load(WatchStore.read(KEY)); }
        catch (exception) { return null; }
    }

    function persist(envelope) as Lang.Boolean {
        if (envelope == null) { return false; }
        try { WatchStore.write(KEY, envelope); return true; }
        catch (exception) { return false; }
    }

    function loadRejected() {
        try { return RejectedTicks.load(WatchStore.read(REJECTED_KEY)); }
        catch (exception) { return null; }
    }

    function persistRejected(store) as Lang.Boolean {
        if (store == null) { return false; }
        try { WatchStore.write(REJECTED_KEY, store); return true; }
        catch (exception) { return false; }
    }

    function activeContext(context) as Lang.Boolean {
        return AuthState.canUseAccess(context) && TokenStore.current(context);
    }

    function all() as Lang.Array {
        var context = TokenStore.snapshot();
        var envelope = loadEnvelope();
        return activeContext(context) && envelope != null ? OwnedTickOutbox.forOwner(envelope, context["owner"]) : [];
    }
    function size() as Lang.Number { return all().size(); }
    function isEmpty() as Lang.Boolean { return size() == 0; }

    function enqueue(input as Lang.Dictionary, context) as Lang.Boolean {
        if (!activeContext(context)) { return false; }
        var envelope = loadEnvelope();
        if (envelope == null) { return false; }
        return persist(OwnedTickOutbox.append(envelope, context["owner"], input, BuildConfig.TICK_QUEUE_MAX));
    }

    function acknowledge(context, uuid as Lang.String) as Lang.Boolean {
        if (!activeContext(context)) { return false; }
        var envelope = loadEnvelope();
        return envelope != null && persist(OwnedTickOutbox.acknowledge(envelope, context["owner"], uuid));
    }

    // Moves a permanently refused tick from this owner's queue to the
    // dead-letter store. The dead-letter write comes FIRST: a failure after
    // it leaves a copy in both stores, never in neither. False (refused,
    // storage failure, store full of unshown entries) keeps the tick queued.
    function reject(context, uuid, reason) as Lang.Boolean {
        if (!activeContext(context) || !(uuid instanceof Lang.String)) { return false; }
        var envelope = loadEnvelope();
        if (envelope == null) { return false; }
        var owner = context["owner"];
        var tick = OwnedTickOutbox.find(envelope, owner, uuid);
        // Already settled by another request for the same UUID.
        if (tick == null) { return true; }
        var store = loadRejected();
        if (store == null || !persistRejected(RejectedTicks.add(store, owner, tick, reason, BuildConfig.REJECTED_TICK_MAX))) {
            return false;
        }
        return persist(OwnedTickOutbox.acknowledge(envelope, owner, uuid));
    }

    // Re-queues at most ONE quarantined pre-G2 tick under the signed-in owner,
    // and only one LegacyTickProof attributes to that exact owner. One at a
    // time keeps an offline drain from filling the queue with old ticks.
    function adoptOneLegacy(context) as Lang.Boolean {
        if (!activeContext(context)) { return false; }
        var envelope = loadEnvelope();
        if (envelope == null) { return false; }
        var proof = null;
        try { proof = LegacyTickProof.fromJwt(WatchStore.read(TokenStore.KEY_JWT)); }
        catch (exception) { return false; }
        return persist(OwnedTickOutbox.adoptOne(envelope, context["owner"], proof,
            BuildConfig.LEGACY_ADOPT_SKEW_SEC, BuildConfig.TICK_QUEUE_MAX));
    }

    // [refused for this owner, held from older builds]. Called when the counts
    // are drawn: it marks this owner's refused ticks as shown, which is what
    // lets a full dead-letter store drop its oldest shown entry. A failed
    // write leaves them unshown, so they stay undroppable.
    function surfaceCounts() as Lang.Array {
        var context = TokenStore.snapshot();
        var envelope = loadEnvelope();
        var held = envelope != null ? envelope["unowned"].size() : 0;
        if (!activeContext(context)) { return [0, held]; }
        var owner = context["owner"];
        var store = loadRejected();
        if (store == null) { return [0, held]; }
        if (RejectedTicks.unseenFor(store, owner) > 0) { persistRejected(RejectedTicks.markSeen(store, owner)); }
        return [RejectedTicks.countFor(store, owner), held];
    }

    // Leases belong to one request, owner, login scope and UUID. A stale
    // completion can release only its own lease; it cannot touch a successor.
    var _leases as Lang.Array = [];
    var _leaseCounter = 0;
    function acquire(context, uuid) {
        if (!activeContext(context) || !(uuid instanceof Lang.String) || _leaseCounter >= AuthState.MAX_COUNTER) { return null; }
        for (var index = 0; index < _leases.size(); index += 1) {
            var existing = _leases[index];
            if (AuthState.sameScope(existing["context"], context) && existing["uuid"].equals(uuid)) { return null; }
        }
        _leaseCounter += 1;
        var lease = { "context" => context, "uuid" => uuid, "id" => _leaseCounter };
        _leases.add(lease);
        return lease;
    }
    function release(lease) as Lang.Boolean {
        if (lease == null) { return false; }
        var retained = [];
        var found = false;
        for (var index = 0; index < _leases.size(); index += 1) {
            if (_leases[index]["id"] == lease["id"]) { found = true; }
            else { retained.add(_leases[index]); }
        }
        _leases = retained;
        return found;
    }

    // Applies one reply for one leased tick. :success and :rejected settle it
    // (true only once storage agrees); :retry and every failure keep it.
    function settle(context, uuid, code as Lang.Number, response) as Lang.Symbol {
        var outcome = classifyFlushResult(code, response, uuid);
        if (outcome == :success) { return acknowledge(context, uuid) ? :success : :retry; }
        if (outcome == :rejected) {
            return reject(context, uuid, rejectionReason(code, response)) ? :rejected : :retry;
        }
        return :retry;
    }
}

// Drains the signed-in owner's queue in order. An acknowledged or permanently
// refused tick is settled and the drain moves on; anything else (transport,
// auth, rate limit, server failure, unknown reply, storage refusal) keeps the
// tick at the front and stops. Once the owner's own queue is empty, provable
// pre-G2 ticks are adopted and sent one at a time.
class TickFlusher {
    private var _client;
    private var _onComplete;
    private var _context;
    private var _lease = null;
    private var _finished = false;
    private var _sent as Lang.Array = [];

    function initialize(client) { _client = client; _context = TokenStore.snapshot(); }
    function start(onComplete) as Void { _onComplete = onComplete; _step(); }
    private function _step() as Void {
        if (_finished) { return; }
        if (_client == null || !TickQueue.activeContext(_context)) { _finish(); return; }
        var pending = TickQueue.all();
        if (pending.size() == 0) {
            if (!TickQueue.adoptOneLegacy(_context)) { _finish(); return; }
            pending = TickQueue.all();
            if (pending.size() == 0) { _finish(); return; }
        }
        var first = pending[0];
        var uuid = first["uuid"];
        // One request per tick per drain, whatever storage does in between.
        for (var index = 0; index < _sent.size(); index += 1) {
            if (_sent[index].equals(uuid)) { _finish(); return; }
        }
        _lease = TickQueue.acquire(_context, uuid);
        if (_lease == null) { _finish(); return; }
        _sent.add(uuid);
        _client.saveTick(first, method(:onResult));
    }
    function onResult(code as Lang.Number, response, origin) as Void {
        var completed = _lease;
        _lease = null;
        if (!TickQueue.release(completed)) { return; }
        if (!AuthState.sameScope(_context, origin) || !TickQueue.activeContext(_context)) { _finish(); return; }
        if (TickQueue.settle(_context, completed["uuid"], code, response) == :retry) { _finish(); return; }
        _step();
    }
    private function _finish() as Void {
        if (_finished) { return; }
        _finished = true;
        if (_onComplete != null) { _onComplete.invoke(); }
    }
}
