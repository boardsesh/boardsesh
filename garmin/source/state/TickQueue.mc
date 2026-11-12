using Toybox.Lang;

// Owner-partitioned durable outbox. Legacy raw arrays remain unowned forever.
// Capacity and storage failure refuse new logs; no queued effort is evicted.
module TickQueue {
    const KEY = "bs.pendingTicks";

    // Bounded G2: every non-exact result retains the tick and stops the drain.
    function classifyFlushResult(code as Lang.Number, exactAck as Lang.Boolean) as Lang.Symbol {
        return code >= 200 && code < 300 && exactAck ? :success : :retry;
    }

    function loadEnvelope() {
        try { return OwnedTickOutbox.load(WatchStore.read(KEY)); }
        catch (exception) { return null; }
    }

    function persist(envelope) as Lang.Boolean {
        if (envelope == null) { return false; }
        try { WatchStore.write(KEY, envelope); return true; }
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

    function exactAck(code as Lang.Number, response, uuid) as Lang.Boolean {
        return code >= 200 && code < 300 && response instanceof Lang.Dictionary &&
            uuid instanceof Lang.String && response["uuid"] instanceof Lang.String && response["uuid"].equals(uuid);
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
}

class TickFlusher {
    private var _client;
    private var _onComplete;
    private var _context;
    private var _lease = null;
    private var _finished = false;

    function initialize(client) { _client = client; _context = TokenStore.snapshot(); }
    function start(onComplete) as Void { _onComplete = onComplete; _step(); }
    private function _step() as Void {
        if (_finished) { return; }
        if (_client == null || !TickQueue.activeContext(_context)) { _finish(); return; }
        var pending = TickQueue.all();
        if (pending.size() == 0) { _finish(); return; }
        var first = pending[0];
        _lease = TickQueue.acquire(_context, first["uuid"]);
        if (_lease == null) { _finish(); return; }
        _client.saveTick(first, method(:onResult));
    }
    function onResult(code as Lang.Number, response, origin) as Void {
        var completed = _lease;
        _lease = null;
        if (!TickQueue.release(completed)) { return; }
        if (!AuthState.sameScope(_context, origin) || !TickQueue.activeContext(_context)) { _finish(); return; }
        if (!TickQueue.exactAck(code, response, completed["uuid"]) ||
                !TickQueue.acknowledge(_context, completed["uuid"])) { _finish(); return; }
        _step();
    }
    private function _finish() as Void {
        if (_finished) { return; }
        _finished = true;
        if (_onComplete != null) { _onComplete.invoke(); }
    }
}
